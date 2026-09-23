import assert from "node:assert/strict";
import test from "node:test";
import { handleSync, type SyncEnv } from "../worker/sync.ts";
import type { SyncRow, SyncStore, SyncTable } from "../worker/sync-store.ts";
import {
  bookPushTime,
  COVER_IMAGE_ID,
  forEachLimit,
  mergeBookMeta,
  mergeNote,
  mergePosition,
  newerListening,
  splitPayload,
  toSyncBookMeta,
  toSyncPatch,
  type PushPayload,
  type SyncRecord,
} from "../lib/sync-merge.ts";

// ---------------------------------------------------------------------------
// 内存 SyncStore:复刻 D1 的号段分配 + ON CONFLICT ... WHERE excluded.updated_at > 现值语义。

function createMemoryStore(): SyncStore & { rows: Map<SyncTable, Map<string, SyncRow>>; sessions: Map<string, number> } {
  const rows = new Map<SyncTable, Map<string, SyncRow>>();
  const table = (name: SyncTable) => {
    let map = rows.get(name);
    if (!map) rows.set(name, (map = new Map()));
    return map;
  };
  let clockValue = 0;
  return {
    rows,
    sessions: new Map(),
    async addSession(hash, expiresAt) {
      this.sessions.set(hash, expiresAt);
    },
    async pruneSessions(now) {
      for (const [hash, exp] of this.sessions) if (exp < now) this.sessions.delete(hash);
    },
    async getSession(hash) {
      return this.sessions.has(hash) ? (this.sessions.get(hash) as number) : null;
    },
    async dropSession(hash) {
      this.sessions.delete(hash);
    },
    async applyPush(batch) {
      if (!batch.length) return;
      clockValue = Math.max(clockValue, Date.now() * 1000) + batch.length;
      const base = clockValue - batch.length;
      batch.forEach(({ table: name, row }, index) => {
        const store = table(name);
        const existing = store.get(row.key);
        if (existing && row.updatedAt <= existing.updatedAt) return; // 新者胜:旧的被拒
        store.set(row.key, { ...row, bookId: row.bookId ?? existing?.bookId ?? null, serverAt: base + index });
      });
    },
    async since(name, watermark, limit) {
      return [...table(name).values()]
        .filter((row) => row.serverAt >= watermark)
        .sort((a, b) => a.serverAt - b.serverAt)
        .slice(0, limit);
    },
  };
}

function createMemoryBucket() {
  const objects = new Map<string, { buffer: ArrayBuffer; contentType: string }>();
  return {
    objects,
    async get(key: string) {
      const found = objects.get(key);
      if (!found) return null;
      return {
        size: found.buffer.byteLength,
        httpMetadata: { contentType: found.contentType },
        body: new Response(found.buffer).body as ReadableStream,
      };
    },
    async head(key: string) {
      const found = objects.get(key);
      return found ? { size: found.buffer.byteLength } : null;
    },
    async put(key: string, value: ArrayBuffer) {
      objects.set(key, { buffer: value, contentType: "application/json" });
    },
  };
}

const USERNAME = "moting";
const PASSWORD = "test-sync-password";

function env() {
  const store = createMemoryStore();
  const bucket = createMemoryBucket();
  const e: SyncEnv = {
    store,
    BOOKS_BUCKET: bucket as unknown as R2Bucket,
    SYNC_USERNAME: USERNAME,
    SYNC_PASSWORD: PASSWORD,
  };
  return { e, store, bucket };
}

function syncRequest(action: string, body: object | null = {}, headers: Record<string, string> = {}, init: RequestInit = {}) {
  const url = `https://reader.example/api/sync/${action}`;
  return new Request(url, {
    method: body === null ? "GET" : "POST",
    headers: {
      origin: "https://reader.example",
      ...(body === null ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === null ? null : JSON.stringify(body),
    ...init,
  });
}

async function loginCookie(e: SyncEnv): Promise<string> {
  const response = await handleSync(
    syncRequest("login", { username: USERNAME, password: PASSWORD }),
    e
  );
  assert.equal(response.status, 200);
  const setCookie = response.headers.getSetCookie()[0];
  assert.match(setCookie, /HttpOnly; SameSite=Strict/);
  assert.match(setCookie, /; Secure/);
  const token = /moting_sync=([^;]+)/.exec(setCookie)?.[1] ?? "";
  assert.ok(token.length > 20);
  return `moting_sync=${token}`;
}

async function jsonOf<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// 会话与鉴权。

test("login issues an HttpOnly cookie; wrong password is rejected without a session", async () => {
  const { e } = env();
  const ok = await handleSync(syncRequest("login", { username: USERNAME, password: PASSWORD }), e);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");

  const bad = await handleSync(syncRequest("login", { username: USERNAME, password: "nope" }), e);
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.getSetCookie().length, 0);
});

test("session probe reports enabled:false when the deployment has no store", async () => {
  const response = await handleSync(syncRequest("session", null), { SYNC_USERNAME: USERNAME, SYNC_PASSWORD: PASSWORD });
  assert.deepEqual(await jsonOf(response), { connected: false, enabled: false });
});

test("push without a valid session is rejected with 401", async () => {
  const { e } = env();
  const response = await handleSync(syncRequest("push", { books: [{ key: "b1", data: "{}", updatedAt: 1 }] }, { cookie: "moting_sync=garbage" }), e);
  assert.equal(response.status, 401);
});

// ---------------------------------------------------------------------------
// push/pull 的记录级 LWW 收敛。

async function pullAll(e: SyncEnv, cookie: string, since = 0) {
  const pages: Array<Record<string, Array<{ key: string; updatedAt: number; data?: unknown; deletedAt?: number }>> & { cursor: number; hasMore: boolean }> = [];
  let cursor = since;
  for (;;) {
    const page = await jsonOf<(typeof pages)[number]>(await handleSync(syncRequest("pull", { since: cursor }, { cookie }), e));
    pages.push(page);
    cursor = page.cursor;
    if (!page.hasMore) break;
  }
  return { pages, cursor };
}

test("push keeps the newer version when an older one arrives later", async () => {
  const { e } = env();
  const cookie = await loginCookie(e);
  const first = await handleSync(syncRequest("push", { books: [{ key: "b1", data: JSON.stringify({ title: "新版" }), updatedAt: 100 }] }, { cookie }), e);
  assert.equal(first.status, 200);
  // 同一本书,更旧的 updated_at 应被拒。
  await handleSync(syncRequest("push", { books: [{ key: "b1", data: JSON.stringify({ title: "旧版" }), updatedAt: 50 }] }, { cookie }), e);
  const { pages } = await pullAll(e, cookie);
  assert.deepEqual(pages[0].books.map((b) => (b.data as { title: string }).title), ["新版"]);
});

test("pull pages across tables by server_at without skipping or repeating rows", async () => {
  const { e } = env();
  const cookie = await loginCookie(e);
  // 两批交错写入三张表,总数远超一页 300 条。
  const notes = Array.from({ length: 450 }, (_, i) => ({ key: `n${i}`, data: JSON.stringify({ id: `n${i}` }), updatedAt: 10 + i, bookId: "b1" }));
  const sessions = Array.from({ length: 200 }, (_, i) => ({ key: `s${i}`, data: JSON.stringify({ id: `s${i}` }), updatedAt: 10 + i }));
  await handleSync(syncRequest("push", { notes: notes.slice(0, 300), sessions: sessions.slice(0, 100) }, { cookie }), e);
  await handleSync(syncRequest("push", { books: [{ key: "b1", data: JSON.stringify({ id: "b1" }), updatedAt: 5 }], notes: notes.slice(300), sessions: sessions.slice(100) }, { cookie }), e);

  const { pages, cursor } = await pullAll(e, cookie);
  assert.ok(pages.length >= 3, `expected several pages, got ${pages.length}`);
  const seen = pages.flatMap((page) => ["books", "notes", "sessions"].flatMap((name) => page[name].map((row) => `${name}:${row.key}`)));
  assert.equal(seen.length, 651);
  assert.equal(new Set(seen).size, 651);

  // 从最终游标再拉:没有新数据时是空页,游标不倒退。
  const again = await pullAll(e, cookie, cursor);
  assert.equal(again.pages[0].notes.length, 0);
  assert.equal(again.cursor, cursor);

  // 之后的写入一定排在游标之后。
  await handleSync(syncRequest("push", { notes: [{ key: "late", data: JSON.stringify({ id: "late" }), updatedAt: 999, bookId: "b1" }] }, { cookie }), e);
  const tail = await pullAll(e, cookie, cursor);
  assert.deepEqual(tail.pages[0].notes.map((row) => row.key), ["late"]);
});

test("a record over the D1 row limit is skipped and reported, the rest of the batch still lands", async () => {
  const { e } = env();
  const cookie = await loginCookie(e);
  const huge = JSON.stringify({ id: "big", blob: "x".repeat(2_000_000) });
  const response = await handleSync(
    syncRequest("push", { chats: [{ key: "big", data: huge, updatedAt: 10 }], notes: [{ key: "n1", data: JSON.stringify({ id: "n1" }), updatedAt: 10, bookId: "b1" }] }, { cookie }),
    e
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await jsonOf<{ tooLarge: Record<string, string[]> }>(response)).tooLarge, { chats: ["big"] });
  const { pages } = await pullAll(e, cookie);
  assert.deepEqual(pages[0].notes.map((row) => row.key), ["n1"]);
  assert.equal(pages[0].chats.length, 0);
});

test("pull returns rows at or after the watermark so a device never loses the other's data", async () => {
  const { e } = env();
  const cookie = await loginCookie(e);
  // 设备 A 推书 X,设备 B 推书 Y(同一云端)。
  await handleSync(syncRequest("push", { books: [{ key: "x", data: JSON.stringify({ id: "x", title: "书X", syncReadyAt: 5 }), updatedAt: 10 }] }, { cookie }), e);
  await handleSync(syncRequest("push", { books: [{ key: "y", data: JSON.stringify({ id: "y", title: "书Y", syncReadyAt: 5 }), updatedAt: 20 }] }, { cookie }), e);
  // 新设备从 since=0 拉取,两本都要出现——首次合并的并集保证。
  const pull = await handleSync(syncRequest("pull", { since: 0 }, { cookie }), e);
  const data = await jsonOf<{ books: Array<{ key: string }> }>(pull);
  assert.deepEqual(new Set(data.books.map((b) => b.key)), new Set(["x", "y"]));
});

test("tombstone delete propagates to pull with deletedAt", async () => {
  const { e } = env();
  const cookie = await loginCookie(e);
  await handleSync(syncRequest("push", { notes: [{ key: "n1", data: JSON.stringify({ id: "n1" }), updatedAt: 10, bookId: "b1" }] }, { cookie }), e);
  const del = await handleSync(syncRequest("push", { notes: [{ key: "n1", data: "", updatedAt: 20, deletedAt: 20 }] }, { cookie }), e);
  assert.equal(del.status, 200);
  // 云端从没见过的划线也能落墓碑(另一台设备可能还留着它)。
  const orphan = await handleSync(syncRequest("push", { notes: [{ key: "n2", data: "", updatedAt: 20, deletedAt: 20 }] }, { cookie }), e);
  assert.equal(orphan.status, 200);
  const pull = await jsonOf<{ notes: Array<{ key: string; deletedAt?: number }> }>(
    await handleSync(syncRequest("pull", { since: 0 }, { cookie }), e)
  );
  assert.equal(pull.notes.find((n) => n.key === "n1")?.deletedAt, 20);
});

// ---------------------------------------------------------------------------
// 输入校验:恶意请求打不到 store。

test("cross-site, bad method and malformed requests are refused outright", async () => {
  const { e } = env();
  const cookie = await loginCookie(e);
  const cases: [Request, number][] = [
    [syncRequest("push", { books: [] }, { origin: "https://attacker.example" }), 403],
    [new Request("https://reader.example/api/sync/push", { method: "DELETE", headers: { "content-type": "application/json" } }), 405],
    [syncRequest("push", { books: "not-a-list" }, { cookie }), 400],
    [syncRequest("pull", { since: -1 }, { cookie }), 400],
  ];
  for (const [input, status] of cases) assert.equal((await handleSync(input, e)).status, status);
});

test("a malformed record is skipped and reported; the good ones in the same batch still land", async () => {
  const { e, store } = env();
  const cookie = await loginCookie(e);
  const future = Date.now() + 3 * 24 * 3600 * 1000; // 时钟快了三天的设备
  const response = await handleSync(
    syncRequest("push", {
      books: [
        { key: "../etc", data: "{}", updatedAt: 1 },
        { key: "skewed", data: "{}", updatedAt: future },
        { key: "good", data: JSON.stringify({ id: "good" }), updatedAt: 10 },
      ],
      settings: [{ key: "Bad Key", data: "{}", updatedAt: 1 }],
    }, { cookie }),
    e
  );
  assert.equal(response.status, 200);
  const body = await jsonOf<{ rejected: Record<string, string[]> }>(response);
  assert.deepEqual(body.rejected, { books: ["../etc", "skewed"], settings: ["Bad Key"] });
  assert.deepEqual([...(store.rows.get("books")?.keys() ?? [])], ["good"]);
  assert.equal(store.rows.get("settings")?.size ?? 0, 0);
});

test("listening progress has its own table and pulls back by key", async () => {
  const { e } = env();
  const cookie = await loginCookie(e);
  const position = { chapterId: "c1", chapterIndex: 0, sentenceId: "s9", sentenceIndex: 9, percent: 40, updatedAt: 500 };
  await handleSync(syncRequest("push", { listening: [{ key: "b1", data: JSON.stringify(position), updatedAt: 500 }] }, { cookie }), e);
  // 更旧的进度晚到,不能覆盖。
  await handleSync(syncRequest("push", { listening: [{ key: "b1", data: JSON.stringify({ ...position, sentenceId: "s1", updatedAt: 100 }), updatedAt: 100 }] }, { cookie }), e);
  const { pages } = await pullAll(e, cookie);
  assert.deepEqual(pages[0].listening.map((row) => (row.data as { sentenceId: string }).sentenceId), ["s9"]);
});

test("HEAD on content and images answers existence without a body, so an interrupted upload can resume", async () => {
  const { e } = env();
  const cookie = await loginCookie(e);
  const head = (path: string) =>
    handleSync(new Request(`https://reader.example/api/sync/${path}`, { method: "HEAD", headers: { origin: "https://reader.example", cookie } }), e);
  assert.equal((await head("book/b1/content")).status, 404);
  await handleSync(
    new Request("https://reader.example/api/sync/book/b1/content", { method: "POST", headers: { "content-type": "application/json", origin: "https://reader.example", cookie }, body: "[]" }),
    e
  );
  const found = await head("book/b1/content");
  assert.equal(found.status, 200);
  assert.equal(await found.text(), "");
  assert.equal((await head("book/b1/images/_cover")).status, 404);
  // 没登录的 HEAD 也得挡住,不能拿来探测别人的书。
  const anonymous = await handleSync(new Request("https://reader.example/api/sync/book/b1/content", { method: "HEAD", headers: { origin: "https://reader.example" } }), e);
  assert.equal(anonymous.status, 401);
});

// ---------------------------------------------------------------------------
// R2 正文存取。

test("book content upload stores bytes, second upload conflicts, download echoes it", async () => {
  const { e, bucket } = env();
  const cookie = await loginCookie(e);
  const chapters = JSON.stringify([{ id: "c1" }]);
  const uploaded = await handleSync(
    new Request("https://reader.example/api/sync/book/b1/content", { method: "POST", headers: { "content-type": "application/json", origin: "https://reader.example", cookie }, body: chapters }),
    e
  );
  assert.equal(uploaded.status, 200);
  assert.ok(bucket.objects.has("books/b1/content.json"));

  const again = await handleSync(
    new Request("https://reader.example/api/sync/book/b1/content", { method: "POST", headers: { "content-type": "application/json", origin: "https://reader.example", cookie }, body: chapters }),
    e
  );
  assert.equal(again.status, 409);

  const fetched = await handleSync(
    new Request("https://reader.example/api/sync/book/b1/content", { method: "GET", headers: { origin: "https://reader.example", cookie } }),
    e
  );
  assert.equal(fetched.status, 200);
  assert.equal(await fetched.text(), chapters);
});

test("content download 404s for a book the cloud never received", async () => {
  const { e } = env();
  const cookie = await loginCookie(e);
  const response = await handleSync(
    new Request("https://reader.example/api/sync/book/ghost/content", { method: "GET", headers: { origin: "https://reader.example", cookie } }),
    e
  );
  assert.equal(response.status, 404);
});

// ---------------------------------------------------------------------------
// 客户端合并纯函数。

test("mergeBookMeta: remote newer wins but local chapters and positions are never clobbered", () => {
  type BookRec = { id: string; title: string; updatedAt: number; syncReadyAt?: number; readingPosition?: unknown; listeningPosition?: unknown };
  const local: BookRec = { id: "b1", title: "本地旧名", updatedAt: 10, readingPosition: { chapterId: "c1" }, listeningPosition: null };
  const remote: SyncRecord = { key: "b1", updatedAt: 20, data: { id: "b1", title: "云端新名", updatedAt: 20, syncReadyAt: 15, readingPosition: { chapterId: "zzz" } } };
  const action = mergeBookMeta(local, remote);
  assert.equal(action.op, "write");
  if (action.op === "write") {
    assert.equal(action.value.title, "云端新名");
    // readingPosition 不跟 meta 走,由 positions 表单独同步。
    assert.equal("readingPosition" in action.value, false);
  }
});

test("mergeBookMeta: a remote book without syncReadyAt is ignored (peer still uploading)", () => {
  const action = mergeBookMeta<{ id: string; updatedAt: number; syncReadyAt?: number }>(undefined, { key: "b1", updatedAt: 5, data: { id: "b1", title: "半本书" } });
  assert.equal(action.op, "keep");
});

test("mergeBookMeta: remote delete only removes a locally-present book", () => {
  type BookRec = { id: string; updatedAt: number; syncReadyAt?: number };
  const local: BookRec = { id: "b1", updatedAt: 1 };
  assert.equal(mergeBookMeta(local, { key: "b1", updatedAt: 1, deletedAt: 5 }).op, "delete");
  assert.equal(mergeBookMeta<BookRec>(undefined, { key: "b2", updatedAt: 1, deletedAt: 5 }).op, "keep");
});

test("mergeNote: newer thought wins, older is dropped, tombstone deletes", () => {
  type NoteRec = { id: string; createdAt: number; updatedAt?: number; thought?: string };
  const local: NoteRec = { id: "n1", createdAt: 10, updatedAt: 10, thought: "旧想法" };
  assert.equal(mergeNote(local, { key: "n1", updatedAt: 20, data: { id: "n1", createdAt: 10, updatedAt: 20, thought: "新想法" } }).op, "write");
  assert.equal(mergeNote(local, { key: "n1", updatedAt: 5, data: { id: "n1", createdAt: 1, updatedAt: 5, thought: "更旧" } }).op, "keep");
  assert.equal(mergeNote(local, { key: "n1", updatedAt: 30, deletedAt: 30 }).op, "delete");
});

test("mergePosition: pure last-writer-wins on savedAt", () => {
  type PosRec = { savedAt: number; position: unknown; lastOpenedAt: number };
  assert.equal(mergePosition<PosRec>(100, { key: "b1", updatedAt: 1, data: { savedAt: 200, position: {}, lastOpenedAt: 200 } }).op, "write");
  assert.equal(mergePosition<PosRec>(300, { key: "b1", updatedAt: 1, data: { savedAt: 200, position: {}, lastOpenedAt: 200 } }).op, "keep");
});

test("bookPushTime lets the syncReadyAt marker propagate past an unchanged updatedAt", () => {
  assert.equal(bookPushTime({ updatedAt: 100, syncReadyAt: 300 }), 300);
  assert.equal(bookPushTime({ updatedAt: 500 }), 500);
});

test("splitPayload batches by total record count so a first big sync fits the server cap", () => {
  const books = Array.from({ length: 950 }, (_, i) => ({ key: `b${i}`, data: "{}", updatedAt: i + 1 }));
  const payload: PushPayload = { books };
  const batches = splitPayload(payload, 400);
  assert.equal(batches.length, 3);
  assert.equal(batches.reduce((sum, b) => sum + (b.books?.length ?? 0), 0), 950);
  assert.ok(batches.every((b) => (b.books?.length ?? 0) <= 400));
});

test("splitPayload also cuts by bytes so a few huge chats never form one oversized request", () => {
  const chats = Array.from({ length: 5 }, (_, i) => ({ key: `c${i}`, data: "x".repeat(1_000_000), updatedAt: i + 1 }));
  const batches = splitPayload({ chats }, 400, 2_500_000);
  assert.equal(batches.length, 3);
  assert.equal(batches.reduce((sum, b) => sum + (b.chats?.length ?? 0), 0), 5);
});

test("covers stay out of D1: book meta and patch original drop their data URLs", () => {
  const meta = toSyncBookMeta({ id: "b1", title: "书", coverDataUrl: "data:image/png;base64,AAAA" });
  assert.equal("coverDataUrl" in meta, false);
  assert.equal(meta.title, "书");
  const patch = toSyncPatch({ bookId: "b1", original: { title: "原名", coverDataUrl: "data:image/png;base64,AAAA" }, applied: { coverDataUrl: "data:image/jpeg;base64,BBBB" } });
  assert.equal("coverDataUrl" in (patch.original ?? {}), false);
  assert.equal(patch.original?.title, "原名");
  // 补全来的新封面很小,而且对端没有别的来源,要保留。
  assert.equal(patch.applied.coverDataUrl, "data:image/jpeg;base64,BBBB");
  assert.match(COVER_IMAGE_ID, /^[A-Za-z0-9_-]{1,64}$/);
});

test("newerListening only takes a strictly newer remote position", () => {
  const local = { sentenceId: "s5", updatedAt: 200 };
  assert.equal(newerListening(local, { sentenceId: "s9", updatedAt: 300 })?.sentenceId, "s9");
  assert.equal(newerListening(local, { sentenceId: "s1", updatedAt: 200 }), null);
  assert.equal(newerListening(undefined, { sentenceId: "s1", updatedAt: 1 })?.sentenceId, "s1");
  assert.equal(newerListening(local, undefined), null);
});

test("forEachLimit keeps at most N tasks in flight and stops taking new work after a failure", async () => {
  let running = 0;
  let peak = 0;
  const done: number[] = [];
  await forEachLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (n) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    done.push(n);
  });
  assert.equal(peak, 4);
  assert.equal(done.length, 9);

  const started: number[] = [];
  await assert.rejects(
    forEachLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], 2, async (n) => {
      started.push(n);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (n === 2) throw new Error("boom");
    }),
    /boom/
  );
  assert.ok(started.length < 9, `should stop early, started ${started.length}`);
});
