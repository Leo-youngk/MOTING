// 同步持久化层:D1 表操作收敛到这个接口,生产用 createD1Store,
// 单元测试用内存实现,让 LWW/墓碑/号段逻辑不经真 D1 也能跑。
export type SyncTable =
  | "books"
  | "notes"
  | "positions"
  | "sessions"
  | "settings"
  | "chats"
  | "patches";

export interface SyncRow {
  key: string;
  data: string;
  updatedAt: number;
  serverAt: number;
  deletedAt: number | null;
  bookId: string | null;
}

export type PushRow = Omit<SyncRow, "serverAt">;

export interface SyncStore {
  /** 写入一条会话 token 的哈希与过期时刻。 */
  addSession(tokenHash: string, expiresAt: number): Promise<void>;
  pruneSessions(now: number): Promise<void>;
  /** 返回该会话的过期时刻;不存在给 null。 */
  getSession(tokenHash: string): Promise<number | null>;
  dropSession(tokenHash: string): Promise<void>;
  /**
   * 原子写入一批记录:预占 server_at 号段与全部 upsert 在同一事务里完成,
   * 并发的 pull 要么看到整批、要么一条都看不到,游标永远不会跳过还没落库的号。
   * 每条按 LWW 只在 updatedAt 更新时生效。
   */
  applyPush(rows: Array<{ table: SyncTable; row: PushRow }>): Promise<void>;
  /** server_at >= watermark 的记录,按 server_at 升序,最多 limit 条。 */
  since(table: SyncTable, watermark: number, limit: number): Promise<SyncRow[]>;
}

// 各表的真实列名映射:books 的内容列叫 meta,其余叫 data。
const VALUE_COLUMN: Record<SyncTable, string> = {
  books: "meta",
  notes: "data",
  positions: "data",
  sessions: "data",
  settings: "data",
  chats: "data",
  patches: "data",
};
const KEY_COLUMN: Record<SyncTable, string> = {
  books: "id",
  notes: "id",
  positions: "book_id",
  sessions: "id",
  settings: "key",
  chats: "book_id",
  patches: "book_id",
};
const HAS_TOMBSTONE: Record<SyncTable, boolean> = {
  books: true,
  notes: true,
  positions: false,
  sessions: false,
  settings: false,
  chats: false,
  patches: false,
};
const HAS_BOOK_ID: Record<SyncTable, boolean> = {
  books: false,
  notes: true,
  positions: false,
  sessions: false,
  settings: false,
  chats: false,
  patches: false,
};

/**
 * D1 单个字符串参数上限 2 MB。一批记录按表打包成 JSON 数组、经 json_each 一条语句写完,
 * 数组超过这个字节数就拆成多条语句。单条记录的上限由 sync.ts 在入口挡住。
 */
export const D1_PARAM_BYTES = 1_900_000;

interface PackedRow {
  i: number;
  k: string;
  d: string;
  u: number;
  x: number | null;
  b: string | null;
}

export function packedRowBytes(row: PackedRow): number {
  return new TextEncoder().encode(JSON.stringify(row)).byteLength + 1;
}

/** 按字节拆包;单行超限的不会出现(入口已挡),这里只保证每包不超。 */
function chunkPacked(rows: PackedRow[]): PackedRow[][] {
  const chunks: PackedRow[][] = [];
  let current: PackedRow[] = [];
  let bytes = 2;
  for (const row of rows) {
    const size = packedRowBytes(row);
    if (current.length && bytes + size > D1_PARAM_BYTES) {
      chunks.push(current);
      current = [];
      bytes = 2;
    }
    current.push(row);
    bytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function upsertSql(table: SyncTable): string {
  const valueColumn = VALUE_COLUMN[table];
  const keyColumn = KEY_COLUMN[table];
  const columns = [keyColumn, valueColumn, "updated_at", "server_at"];
  // 号段在同一事务的第一条语句里刚占好:此刻 server_clock 就是本批的上界。
  const values = [
    "json_extract(value, '$.k')",
    "json_extract(value, '$.d')",
    "json_extract(value, '$.u')",
    "(SELECT value FROM sync_meta WHERE key = 'server_clock') - ?2 + json_extract(value, '$.i')",
  ];
  const updates = [
    `${valueColumn} = excluded.${valueColumn}`,
    "updated_at = excluded.updated_at",
    "server_at = excluded.server_at",
  ];
  if (HAS_TOMBSTONE[table]) {
    columns.push("deleted_at");
    values.push("json_extract(value, '$.x')");
    updates.push("deleted_at = excluded.deleted_at");
  }
  if (HAS_BOOK_ID[table]) {
    // 划线墓碑不带 bookId,而 book_id 列 NOT NULL:插入时补空串,更新时保留原值。
    columns.push("book_id");
    values.push("COALESCE(json_extract(value, '$.b'), '')");
    updates.push(`book_id = COALESCE(NULLIF(excluded.book_id, ''), ${table}.book_id)`);
  }
  // SELECT 后的 WHERE true 是 SQLite 的语法要求:否则 ON CONFLICT 会被解析成 JOIN 约束。
  return (
    `INSERT INTO ${table} (${columns.join(", ")}) ` +
    `SELECT ${values.join(", ")} FROM json_each(?1) WHERE true ` +
    `ON CONFLICT(${keyColumn}) DO UPDATE SET ${updates.join(", ")} ` +
    `WHERE excluded.updated_at > ${table}.updated_at`
  );
}

export function createD1Store(db: D1Database): SyncStore {
  return {
    async addSession(tokenHash, expiresAt) {
      await db.prepare("INSERT INTO auth_tokens (token_hash, expires_at) VALUES (?, ?)").bind(tokenHash, expiresAt).run();
    },
    async pruneSessions(now) {
      await db.prepare("DELETE FROM auth_tokens WHERE expires_at < ?").bind(now).run();
    },
    async getSession(tokenHash) {
      const row = await db.prepare("SELECT expires_at FROM auth_tokens WHERE token_hash = ?").bind(tokenHash).first<{ expires_at: number }>();
      return row ? Number(row.expires_at) : null;
    },
    async dropSession(tokenHash) {
      await db.prepare("DELETE FROM auth_tokens WHERE token_hash = ?").bind(tokenHash).run();
    },
    async applyPush(rows) {
      if (!rows.length) return;
      const count = rows.length;
      const byTable = new Map<SyncTable, PackedRow[]>();
      rows.forEach(({ table, row }, index) => {
        let list = byTable.get(table);
        if (!list) byTable.set(table, (list = []));
        list.push({ i: index, k: row.key, d: row.data, u: row.updatedAt, x: row.deletedAt, b: row.bookId });
      });
      // D1 的 batch 是一个事务:占号段 + 全部 upsert 要么全成、要么全不成。
      // 免费档每次调用限 50 条查询,这里无论多少记录都只有 1 + 表数(×分包)条。
      const statements = [
        db
          .prepare(
            "INSERT INTO sync_meta (key, value) VALUES ('server_clock', ?1 + ?2) " +
              "ON CONFLICT(key) DO UPDATE SET value = MAX(value, ?1) + ?2"
          )
          .bind(Date.now() * 1000, count),
      ];
      for (const [table, list] of byTable) {
        const sql = upsertSql(table);
        for (const chunk of chunkPacked(list)) {
          statements.push(db.prepare(sql).bind(JSON.stringify(chunk), count));
        }
      }
      await db.batch(statements);
    },
    async since(table, watermark, limit) {
      const valueColumn = VALUE_COLUMN[table];
      const keyColumn = KEY_COLUMN[table];
      const { results } = await db
        .prepare(
          `SELECT ${keyColumn} AS key, ${valueColumn} AS data, updated_at, server_at` +
            `${HAS_TOMBSTONE[table] ? ", deleted_at" : ""}${HAS_BOOK_ID[table] ? ", book_id" : ""} ` +
            `FROM ${table} WHERE server_at >= ? ORDER BY server_at LIMIT ${limit}`
        )
        .bind(watermark)
        .all<Record<string, unknown>>();
      return (results ?? []).map((raw) => ({
        key: String(raw.key),
        data: String(raw.data ?? ""),
        updatedAt: Number(raw.updated_at),
        serverAt: Number(raw.server_at),
        deletedAt: raw.deleted_at ? Number(raw.deleted_at) : null,
        bookId: raw.book_id ? String(raw.book_id) : null,
      }));
    },
  };
}
