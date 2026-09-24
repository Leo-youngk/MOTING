import { normalizeVoiceURI } from "./edge-voices";
import type { BookMetadataPatch } from "./book-metadata-types";
import { outlineOf } from "./content";
import type {
  Book,
  BookAiChat,
  BookImage,
  BookMeta,
  BookNote,
  BookPosition,
  Chapter,
  ReaderSettings,
  ReadingSession,
  ReadingStats,
} from "./types";
import { DEFAULT_SETTINGS, DEFAULT_STATS } from "./types";

const DB_NAME = "moting-reader";
/** 5：正文从书目记录里拆到 contents 表。 */
const DB_VERSION = 5;
const BOOK_STORE = "books";
/** 书的正文，一本书一条，主键 bookId。书目在 books 表里，打开这本书时才读这里。 */
const CONTENT_STORE = "contents";
const NOTE_STORE = "notes";
const SETTINGS_STORE = "settings";
const IMAGE_STORE = "images";
const CHAT_STORE = "chats";
const SESSION_STORE = "sessions";
const READING_POSITION_PREFIX = "reading-position:";
/** 线上补全的书籍资料。跟阅读位置一样单独存，不写回体积巨大的 Book 记录。 */
const BOOK_METADATA_PREFIX = "book-metadata:";
// 云端同步的本地状态,都放在 settings store 里。
const SYNC_STATE_KEY = "sync:state";
const SETTINGS_MTIME_KEY = "reader-mtime";

let dbPromise: Promise<IDBDatabase> | null = null;

interface StoredReadingPosition {
  position: BookPosition;
  lastOpenedAt: number;
  savedAt: number;
}

interface StoredContent {
  bookId: string;
  chapters: Chapter[];
}

/** 已删除书/划线的墓碑。push 被服务端接受后清理。 */
export interface SyncTombstones {
  books: Record<string, number>;
  notes: Record<string, number>;
}

/**
 * 云端同步的本地状态。两个水位分属两台时钟,绝不能混用:
 * - pushedAt:本机时钟(毫秒)。上次成功同步开始的时刻,本地记录的修改时间比它新才需要上传。
 * - pullCursor:服务端号段(server_at)。下次 pull 从这里接着拉。
 */
export interface SyncState {
  /** 同步协议的数据版本。客户端新增同步类别时加一,旧版本的设备会整体补传一次。 */
  schema: number;
  pushedAt: number;
  pullCursor: number;
  tombstones: SyncTombstones;
  pendingContent: string[];
}

const DEFAULT_SYNC_STATE: SyncState = {
  schema: 0,
  pushedAt: 0,
  pullCursor: 0,
  tombstones: { books: {}, notes: {} },
  pendingContent: [],
};

/** 应用云端变更时传 tombstone:false——那是别人删的,不该再以本机名义推回去。 */
export interface SyncWriteOptions {
  tombstone?: boolean;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("浏览器本地存储操作失败"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("浏览器本地存储写入失败"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("浏览器本地存储写入被中止"));
  });
}

/** 旧库升级（把正文从书目里搬出去）的进行状态。只在老用户第一次打开新版时出现一次。 */
const upgradeListeners = new Set<(upgrading: boolean) => void>();

export function onStorageUpgrade(listener: (upgrading: boolean) => void): () => void {
  upgradeListeners.add(listener);
  return () => {
    upgradeListeners.delete(listener);
  };
}

function notifyUpgrade(upgrading: boolean): void {
  upgradeListeners.forEach((listener) => listener(upgrading));
}

/**
 * v4 → v5：书目记录里的 chapters 搬进 contents 表，书目留一份目录。
 *
 * 就在升级事务里逐本做：游标一次只拿一本，内存峰值是一本书；
 * 中途任何一步失败整个事务回滚，库停在 v4 原样，下次打开再来。
 */
function moveContentsOutOfBooks(transaction: IDBTransaction): void {
  const contents = transaction.objectStore(CONTENT_STORE);
  const request = transaction.objectStore(BOOK_STORE).openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const record = cursor.value as Partial<Book> & { id: string };
    if (Array.isArray(record.chapters)) {
      const { chapters, ...meta } = record;
      contents.put({ bookId: record.id, chapters } satisfies StoredContent);
      cursor.update({ ...meta, chapterOutline: outlineOf(chapters) });
    }
    cursor.continue();
  };
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("当前浏览器不支持本地书库"));
  }
  if (dbPromise) return dbPromise;

  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let upgrading = false;
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CONTENT_STORE)) {
        db.createObjectStore(CONTENT_STORE, { keyPath: "bookId" });
      }
      if (event.oldVersion > 0 && event.oldVersion < 5 && request.transaction) {
        upgrading = true;
        notifyUpgrade(true);
        moveContentsOutOfBooks(request.transaction);
      }
      if (!db.objectStoreNames.contains(BOOK_STORE)) {
        db.createObjectStore(BOOK_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(NOTE_STORE)) {
        const notes = db.createObjectStore(NOTE_STORE, { keyPath: "id" });
        notes.createIndex("bookId", "bookId", { unique: false });
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE);
      }
      if (!db.objectStoreNames.contains(IMAGE_STORE)) {
        const images = db.createObjectStore(IMAGE_STORE, { keyPath: "id" });
        images.createIndex("bookId", "bookId", { unique: false });
      }
      if (!db.objectStoreNames.contains(CHAT_STORE)) {
        // 一本书一条常驻对话，bookId 本身就是主键，不用像 notes 那样另建索引。
        db.createObjectStore(CHAT_STORE, { keyPath: "bookId" });
      }
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        const sessions = db.createObjectStore(SESSION_STORE, { keyPath: "id" });
        sessions.createIndex("bookId", "bookId", { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (upgrading) notifyUpgrade(false);
      // 别的页面要升级数据库时让出连接，否则它会一直卡在 blocked。
      db.onversionchange = () => {
        db.close();
        if (dbPromise === promise) dbPromise = null;
      };
      db.onclose = () => {
        if (dbPromise === promise) dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      if (upgrading) notifyUpgrade(false);
      if (dbPromise === promise) dbPromise = null;
      reject(request.error ?? new Error("无法打开浏览器本地书库"));
    };
    request.onblocked = () => {
      if (dbPromise === promise) dbPromise = null;
      reject(new Error("请关闭其他正在使用墨听的页面后重试"));
    };
  });
  dbPromise = promise;

  return dbPromise;
}

function readingPositionKey(bookId: string): string {
  return `${READING_POSITION_PREFIX}${bookId}`;
}

function bookMetadataKey(bookId: string): string {
  return `${BOOK_METADATA_PREFIX}${bookId}`;
}

/** settings 表里某一类前缀的全部键。只读这一段，不把整张表连同别的大记录一起捞出来。 */
function prefixRange(prefix: string): IDBKeyRange {
  return IDBKeyRange.bound(prefix, `${prefix}￿`);
}

async function readPrefixed(
  store: IDBObjectStore,
  prefix: string
): Promise<Array<[string, unknown]>> {
  const range = prefixRange(prefix);
  const [values, keys] = await Promise.all([
    requestToPromise(store.getAll(range) as IDBRequest<unknown[]>),
    requestToPromise(store.getAllKeys(range)),
  ]);
  return keys.map((key, index) => [String(key).slice(prefix.length), values[index]]);
}

function validPosition(value: unknown): value is StoredReadingPosition {
  const record = value as Partial<StoredReadingPosition> | undefined;
  return Boolean(
    record?.position &&
      typeof record.savedAt === "number" &&
      Number.isFinite(record.savedAt) &&
      typeof record.lastOpenedAt === "number" &&
      Number.isFinite(record.lastOpenedAt)
  );
}

/** 书库要显示的书目：叠上阅读位置和线上补全的资料，不含正文。 */
export async function getAllBooks(): Promise<BookMeta[]> {
  const db = await openDatabase();
  const transaction = db.transaction([BOOK_STORE, SETTINGS_STORE], "readonly");
  const settings = transaction.objectStore(SETTINGS_STORE);
  const [metas, positions, patches] = await Promise.all([
    requestToPromise(transaction.objectStore(BOOK_STORE).getAll() as IDBRequest<BookMeta[]>),
    readPrefixed(settings, READING_POSITION_PREFIX),
    readPrefixed(settings, BOOK_METADATA_PREFIX),
  ]);
  const positionById = new Map(
    positions.filter((entry): entry is [string, StoredReadingPosition] => validPosition(entry[1]))
  );
  const patchById = new Map(
    patches.filter((entry): entry is [string, BookMetadataPatch] => Boolean(entry[1] && typeof entry[1] === "object"))
  );
  return metas
    .map((meta) => {
      const record = positionById.get(meta.id);
      const merged =
        !record || record.savedAt <= meta.updatedAt
          ? meta
          : {
              ...meta,
              readingPosition: record.position,
              lastOpenedAt: Math.max(meta.lastOpenedAt, record.lastOpenedAt),
              updatedAt: record.savedAt,
            };
      return applyBookMetadata(merged, patchById.get(meta.id));
    })
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

/**
 * 线上补全的书名/作者/封面只在读出来的这一刻盖上去，书目记录本身保持导入时的原样。
 * 删掉补丁记录，书就恢复原貌——这也是「还原成导入时的资料」能成立的前提。
 */
function applyBookMetadata(
  book: BookMeta,
  patch: BookMetadataPatch | undefined
): BookMeta {
  const applied = patch?.applied;
  if (!applied) return book;
  return {
    ...book,
    title: applied.title ?? book.title,
    author: applied.author ?? book.author,
    coverDataUrl: applied.coverDataUrl ?? book.coverDataUrl,
  };
}

export async function getAllBookMetadata(): Promise<BookMetadataPatch[]> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readonly");
  const patches = await readPrefixed(transaction.objectStore(SETTINGS_STORE), BOOK_METADATA_PREFIX);
  return patches
    .map(([, value]) => value)
    .filter((value): value is BookMetadataPatch => Boolean(value && typeof value === "object"));
}

export async function saveBookMetadata(patch: BookMetadataPatch): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readwrite");
  transaction
    .objectStore(SETTINGS_STORE)
    .put(patch, bookMetadataKey(patch.bookId));
  await transactionDone(transaction);
}

export async function removeBookMetadata(bookId: string): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readwrite");
  transaction.objectStore(SETTINGS_STORE).delete(bookMetadataKey(bookId));
  await transactionDone(transaction);
}

/** 书目和正文分两张表写；目录每次都从正文重算，两边不会对不上。 */
function putBook(transaction: IDBTransaction, book: Book): void {
  const { chapters, ...meta } = book;
  transaction.objectStore(BOOK_STORE).put({ ...meta, chapterOutline: outlineOf(chapters) });
  transaction.objectStore(CONTENT_STORE).put({ bookId: book.id, chapters } satisfies StoredContent);
}

/** 写整本书（书目 + 正文）。只有导入、同步下载、生成示例书这类「正文本身变了」的场合用。 */
export async function saveBook(book: Book): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction([BOOK_STORE, CONTENT_STORE], "readwrite");
  putBook(transaction, book);
  await transactionDone(transaction);
}

/** 整条覆盖书目。同步合并远端书目时用：那边给的是完整一条。 */
export async function saveBookMeta(meta: BookMeta): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(BOOK_STORE, "readwrite");
  const { chapters: _chapters, ...clean } = meta as BookMeta & { chapters?: unknown };
  transaction.objectStore(BOOK_STORE).put(clean);
  await transactionDone(transaction);
}

/**
 * 改书目里的几个字段，在同一个事务里读出库里那条再合并写回。
 *
 * 不拿内存里的书整条写回：内存里那份叠过线上补全的书名封面，
 * 写回去就等于把补丁焊死进了原始记录，「还原成导入时的资料」从此失效。
 */
export async function updateBookMeta(
  bookId: string,
  changes: Partial<Omit<BookMeta, "id">>
): Promise<BookMeta | undefined> {
  const db = await openDatabase();
  const transaction = db.transaction(BOOK_STORE, "readwrite");
  const store = transaction.objectStore(BOOK_STORE);
  let updated: BookMeta | undefined;
  const request = store.get(bookId);
  request.onsuccess = () => {
    const current = request.result as BookMeta | undefined;
    if (!current) return;
    updated = { ...current, ...changes, id: current.id };
    store.put(updated);
  };
  await transactionDone(transaction);
  return updated;
}

export async function getBookMeta(bookId: string): Promise<BookMeta | undefined> {
  const db = await openDatabase();
  const transaction = db.transaction(BOOK_STORE, "readonly");
  return requestToPromise(
    transaction.objectStore(BOOK_STORE).get(bookId) as IDBRequest<BookMeta | undefined>
  );
}

/** 一本书的正文。打开阅读器、播放器、单书笔记时才读。 */
export async function getBookContent(bookId: string): Promise<Chapter[] | undefined> {
  const db = await openDatabase();
  const transaction = db.transaction(CONTENT_STORE, "readonly");
  const record = await requestToPromise(
    transaction.objectStore(CONTENT_STORE).get(bookId) as IDBRequest<StoredContent | undefined>
  );
  return record?.chapters;
}

/** 库里原样的整本书（不叠补丁）。同步上传正文时用，内存里同时只有这一本。 */
export async function getBook(bookId: string): Promise<Book | undefined> {
  const db = await openDatabase();
  const transaction = db.transaction([BOOK_STORE, CONTENT_STORE], "readonly");
  const [meta, content] = await Promise.all([
    requestToPromise(transaction.objectStore(BOOK_STORE).get(bookId) as IDBRequest<BookMeta | undefined>),
    requestToPromise(transaction.objectStore(CONTENT_STORE).get(bookId) as IDBRequest<StoredContent | undefined>),
  ]);
  return meta && content ? { ...meta, chapters: content.chapters } : undefined;
}

function deleteByBookId(store: IDBObjectStore, bookId: string): void {
  const request = store.index("bookId").openCursor(IDBKeyRange.only(bookId));
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  };
}

/** 库里原样的全部书目（不叠补丁、不叠阅读位置），同步用。 */
export async function getBookMetas(): Promise<BookMeta[]> {
  const db = await openDatabase();
  const transaction = db.transaction(BOOK_STORE, "readonly");
  const metas = await requestToPromise(
    transaction.objectStore(BOOK_STORE).getAll() as IDBRequest<BookMeta[]>
  );
  return metas.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

/** 全部阅读/听书位置,同步用。 */
export async function getAllReadingPositions(): Promise<
  Array<{ bookId: string; position: BookPosition; lastOpenedAt: number; savedAt: number }>
> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readonly");
  const positions = await readPrefixed(transaction.objectStore(SETTINGS_STORE), READING_POSITION_PREFIX);
  return positions
    .filter((entry): entry is [string, StoredReadingPosition] => validPosition(entry[1]))
    .map(([bookId, record]) => ({
      bookId,
      position: record.position,
      lastOpenedAt: record.lastOpenedAt,
      savedAt: record.savedAt,
    }));
}

export async function getSyncState(): Promise<SyncState> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readonly");
  const state = await requestToPromise(transaction.objectStore(SETTINGS_STORE).get(SYNC_STATE_KEY));
  if (!state || typeof state !== "object") return { ...DEFAULT_SYNC_STATE, tombstones: { books: {}, notes: {} } };
  const stored = state as Partial<SyncState>;
  return {
    schema: typeof stored.schema === "number" ? stored.schema : 0,
    pushedAt: typeof stored.pushedAt === "number" ? stored.pushedAt : 0,
    pullCursor: typeof stored.pullCursor === "number" ? stored.pullCursor : 0,
    tombstones: {
      books: stored.tombstones?.books ?? {},
      notes: stored.tombstones?.notes ?? {},
    },
    pendingContent: Array.isArray(stored.pendingContent) ? stored.pendingContent : [],
  };
}

export async function saveSyncState(state: SyncState): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readwrite");
  transaction.objectStore(SETTINGS_STORE).put(state, SYNC_STATE_KEY);
  await transactionDone(transaction);
}

/** settings 本身的修改时间,LWW 用;没有它就分不清「没改」和「改了」。 */
/**
 * settings 的修改时间。存过设置但没有 mtime 的(同步上线前保存的)记为 1:
 * 它要能被推上去,但任何一台设备上真正改过的设置都比它新。
 * 从没存过设置(全是默认值)的设备记 0,不推,等着拉别人的。
 */
export async function getSettingsMtime(): Promise<number> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readonly");
  const store = transaction.objectStore(SETTINGS_STORE);
  const [mtime, settings] = await Promise.all([
    requestToPromise(store.get(SETTINGS_MTIME_KEY)),
    requestToPromise(store.get("reader")),
  ]);
  if (typeof mtime === "number") return mtime;
  return settings ? 1 : 0;
}

/**
 * 在 readwrite 事务内增删墓碑;get→put 链在同事务里自动延续。
 * 重新写回的记录(比如撤销删除)要摘掉自己的墓碑,否则下次同步会把它再删一遍。
 */
function editTombstones(
  store: IDBObjectStore,
  kind: "books" | "notes",
  added: Record<string, number>,
  cleared: string[] = []
): void {
  if (!Object.keys(added).length && !cleared.length) return;
  const request = store.get(SYNC_STATE_KEY);
  request.onsuccess = () => {
    const state = (request.result as SyncState | undefined) ?? DEFAULT_SYNC_STATE;
    const list = { ...state.tombstones[kind] };
    for (const id of cleared) delete list[id];
    Object.assign(list, added);
    const tombstones: SyncTombstones = { ...state.tombstones, [kind]: list };
    store.put({ ...state, tombstones }, SYNC_STATE_KEY);
  };
}

/** 阅读记录不跟着删：书没了，那段时间也确实读过。 */
export async function removeBook(bookId: string, { tombstone = true }: SyncWriteOptions = {}): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(
    [BOOK_STORE, CONTENT_STORE, NOTE_STORE, IMAGE_STORE, CHAT_STORE, SETTINGS_STORE],
    "readwrite"
  );
  transaction.objectStore(BOOK_STORE).delete(bookId);
  transaction.objectStore(CONTENT_STORE).delete(bookId);
  deleteByBookId(transaction.objectStore(NOTE_STORE), bookId);
  deleteByBookId(transaction.objectStore(IMAGE_STORE), bookId);
  transaction.objectStore(CHAT_STORE).delete(bookId);
  transaction.objectStore(SETTINGS_STORE).delete(readingPositionKey(bookId));
  // 补丁必须跟着删：留着的话重新导入同一本书、复用到同一个 id 时会串到旧资料上。
  transaction.objectStore(SETTINGS_STORE).delete(bookMetadataKey(bookId));
  // 删除墓碑:同步时告知其他设备同样删除。本地清空(clearLibrary)不走这里,云端保留。
  if (tombstone) editTombstones(transaction.objectStore(SETTINGS_STORE), "books", { [bookId]: Date.now() });
  await transactionDone(transaction);
}

/** 只保存阅读位置，不复制整本正文；正文仍由 saveBook 负责持久化。 */
export async function saveReadingPositions(
  entries: Array<{
    bookId: string;
    position: BookPosition;
    lastOpenedAt: number;
    savedAt: number;
  }>
): Promise<void> {
  if (!entries.length) return;
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readwrite");
  const store = transaction.objectStore(SETTINGS_STORE);
  for (const entry of entries) {
    store.put(
      {
        position: entry.position,
        lastOpenedAt: entry.lastOpenedAt,
        savedAt: entry.savedAt,
      } satisfies StoredReadingPosition,
      readingPositionKey(entry.bookId)
    );
  }
  await transactionDone(transaction);
}

/** 书目、正文与插图放在同一个事务，存储失败时不留下半本书。 */
export async function saveImportedBook(book: Book, images: BookImage[]): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction([BOOK_STORE, CONTENT_STORE, IMAGE_STORE], "readwrite");
  putBook(transaction, book);
  for (const image of images) transaction.objectStore(IMAGE_STORE).put(image);
  await transactionDone(transaction);
}

export async function getBookImage(
  imageId: string
): Promise<BookImage | undefined> {
  const db = await openDatabase();
  const transaction = db.transaction(IMAGE_STORE, "readonly");
  return requestToPromise(
    transaction.objectStore(IMAGE_STORE).get(imageId) as IDBRequest<
      BookImage | undefined
    >
  );
}

export async function getAllNotes(): Promise<BookNote[]> {
  const db = await openDatabase();
  const transaction = db.transaction(NOTE_STORE, "readonly");
  const notes = await requestToPromise(
    transaction.objectStore(NOTE_STORE).getAll() as IDBRequest<BookNote[]>
  );
  return notes
    .map((note) =>
      // 早期版本把整句标记存成 kind: "bookmark"，现在统一当成整句划线。
      (note.kind as string) === "bookmark"
        ? { ...note, kind: "highlight" as const }
        : note
    )
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveNote(note: BookNote): Promise<void> {
  await writeNotes([note]);
}

/** 一次划线跨多句时，正文标记、改色和删除必须整组提交或整组回滚。 */
export async function writeNotes(
  notes: BookNote[],
  removedIds: string[] = [],
  { tombstone = true }: SyncWriteOptions = {}
): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction([NOTE_STORE, SETTINGS_STORE], "readwrite");
  const done = transactionDone(transaction);
  try {
    const store = transaction.objectStore(NOTE_STORE);
    for (const note of notes) {
      // 旧记录没有 updatedAt 时补上;同步 LWW 靠它区分「没改」和「改了」。
      store.put({ ...note, updatedAt: note.updatedAt ?? note.createdAt });
    }
    for (const id of removedIds) store.delete(id);
    if (tombstone) {
      const removedAt = Date.now();
      editTombstones(
        transaction.objectStore(SETTINGS_STORE),
        "notes",
        Object.fromEntries(removedIds.map((id) => [id, removedAt])),
        notes.map((note) => note.id)
      );
    }
  } catch (error) {
    transaction.abort();
    await done.catch(() => undefined);
    throw error;
  }
  await done;
}

export async function removeNote(noteId: string): Promise<void> {
  await writeNotes([], [noteId]);
}

export async function getAllChats(): Promise<BookAiChat[]> {
  const db = await openDatabase();
  const transaction = db.transaction(CHAT_STORE, "readonly");
  return requestToPromise(
    transaction.objectStore(CHAT_STORE).getAll() as IDBRequest<BookAiChat[]>
  );
}

export async function saveChat(chat: BookAiChat): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(CHAT_STORE, "readwrite");
  transaction.objectStore(CHAT_STORE).put(chat);
  await transactionDone(transaction);
}

export async function getAllSessions(): Promise<ReadingSession[]> {
  const db = await openDatabase();
  const transaction = db.transaction(SESSION_STORE, "readonly");
  const sessions = await requestToPromise(
    transaction.objectStore(SESSION_STORE).getAll() as IDBRequest<
      ReadingSession[]
    >
  );
  return sessions.sort((a, b) => b.startedAt - a.startedAt);
}

export async function saveSession(session: ReadingSession): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(SESSION_STORE, "readwrite");
  transaction.objectStore(SESSION_STORE).put(session);
  await transactionDone(transaction);
}

/**
 * 同步拉回来的阅读记录：本地没有、或远端那条更晚结束才写。返回真正写了几条。
 *
 * 本机刚推上去的记录，下一次拉取会原样回来一遍。以前不分青红皂白整批写、
 * 再通知界面「有变化」，于是每轮同步都要把整个书库重读一遍。
 */
export async function saveSessionsIfNewer(sessions: ReadingSession[]): Promise<number> {
  if (!sessions.length) return 0;
  const db = await openDatabase();
  const transaction = db.transaction(SESSION_STORE, "readwrite");
  const store = transaction.objectStore(SESSION_STORE);
  let written = 0;
  for (const session of sessions) {
    const request = store.get(session.id);
    request.onsuccess = () => {
      const local = request.result as ReadingSession | undefined;
      if (local && local.endedAt >= session.endedAt) return;
      store.put(session);
      written += 1;
    };
  }
  await transactionDone(transaction);
  return written;
}

export async function getSettings(): Promise<ReaderSettings> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readonly");
  const settings = await requestToPromise(
    transaction.objectStore(SETTINGS_STORE).get("reader")
  );
  const merged = { ...DEFAULT_SETTINGS, ...(settings ?? {}) } as ReaderSettings;
  // 旧版三主题（paper/white/night）迁移到对齐 Apple Books 的六主题。
  const legacyTheme: Partial<Record<string, ReaderSettings["theme"]>> = {
    paper: "calm",
    white: "original",
    night: "quiet",
  };
  const mapped = legacyTheme[merged.theme as string];
  if (mapped) merged.theme = mapped;
  // 选过已经下架的音色（或者系统语音）的，回到默认音色。
  merged.voiceURI = normalizeVoiceURI(merged.voiceURI);
  return merged;
}

export async function saveSettings(
  settings: ReaderSettings,
  mtime = Date.now()
): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readwrite");
  const store = transaction.objectStore(SETTINGS_STORE);
  store.put(settings, "reader");
  // mtime 跟 settings 同事务落盘,同步时才能可靠地按「谁后改」合并。
  // 同步拉回来的新设置用它自己的远程时间,避免本地时间把 LWW 摚乱。
  store.put(mtime, SETTINGS_MTIME_KEY);
  await transactionDone(transaction);
}

/** 早期版本存下的每日阅读时长基数;没有就是 null(新设备,或从没用过早期版本)。 */
export async function getLegacyStats(): Promise<ReadingStats | null> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readonly");
  const stats = await requestToPromise(transaction.objectStore(SETTINGS_STORE).get("stats"));
  if (!stats || typeof stats !== "object") return null;
  const days = (stats as Partial<ReadingStats>).days;
  return days && typeof days === "object" && Object.keys(days).length ? { days } : null;
}

/**
 * 把别的设备的历史基数并进来:同一天取较大值。按天取大是幂等的,
 * 重复拉取、两台设备互相合并都不会把时长越加越多。返回本地是否有变化。
 */
export async function mergeLegacyStats(remote: ReadingStats): Promise<boolean> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readwrite");
  const store = transaction.objectStore(SETTINGS_STORE);
  let changed = false;
  // get→put 用回调串在同一事务里;中间插 await 的话 Safari 可能先把事务提交掉。
  const request = store.get("stats");
  request.onsuccess = () => {
    const current = request.result as Partial<ReadingStats> | undefined;
    const days: Record<string, number> = { ...(current?.days ?? {}) };
    for (const [day, seconds] of Object.entries(remote.days ?? {})) {
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= (days[day] ?? 0)) continue;
      days[day] = seconds;
      changed = true;
    }
    if (changed) store.put({ ...(current ?? {}), days }, "stats");
  };
  await transactionDone(transaction);
  return changed;
}

export async function getStats(): Promise<ReadingStats> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS_STORE, "readonly");
  const stats = await requestToPromise(
    transaction.objectStore(SETTINGS_STORE).get("stats")
  );
  return { ...DEFAULT_STATS, ...(stats ?? {}) };
}

export async function clearLibrary(): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(
    [
      BOOK_STORE,
      CONTENT_STORE,
      NOTE_STORE,
      SETTINGS_STORE,
      IMAGE_STORE,
      CHAT_STORE,
      SESSION_STORE,
    ],
    "readwrite"
  );
  transaction.objectStore(BOOK_STORE).clear();
  transaction.objectStore(CONTENT_STORE).clear();
  transaction.objectStore(NOTE_STORE).clear();
  transaction.objectStore(SETTINGS_STORE).clear();
  transaction.objectStore(IMAGE_STORE).clear();
  transaction.objectStore(CHAT_STORE).clear();
  transaction.objectStore(SESSION_STORE).clear();
  await transactionDone(transaction);
}
