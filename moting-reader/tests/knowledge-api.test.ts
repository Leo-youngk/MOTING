import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleKnowledgeApi } from "../worker/knowledge-api.ts";
import { forwardSync, handleSync } from "../worker/sync.ts";
import { recordHash, recordObjectKey, STORED_BLOB_PREFIX, utf8Bytes } from "../lib/sync-record.ts";

/** 真 SQLite 执行生产 SQL，覆盖 D1 参数绑定、关联删除及键排序。 */
function setup() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync(new URL("../worker/sync-schema.sql", import.meta.url), "utf8"));
  sql.exec(readFileSync(new URL("../worker/migrations/0002_knowledge_api.sql", import.meta.url), "utf8"));
  sql.prepare("INSERT INTO sync_meta VALUES ('server_clock', ?)").run(10000);
  const db = { prepare(query: string) {
    let params: (string | number | null)[] = [];
    const statement = {
      bind(...values: typeof params) { params = values; return statement; },
      async first() { return sql.prepare(query).get(...params) ?? null; },
      async all() { return { results: sql.prepare(query).all(...params), success: true }; },
      async run() { const result = sql.prepare(query).run(...params); return { success: true, meta: { changes: Number(result.changes) } }; },
    };
    return statement;
  } } as unknown as D1Database;
  const blobs = new Map<string, string>();
  const bucket = { async get(key: string) { const body = blobs.get(key); return body === undefined ? null : { body: new Response(body).body, size: utf8Bytes(body) }; } } as unknown as R2Bucket;
  const env = { DB: db, BOOKS_BUCKET: bucket, SYNC_USERNAME: "knowledge-test", SYNC_PASSWORD: "local-test-password" };
  const now = Date.now() - 1000;
  const book = (id: string, v: number, deleted = false, data?: unknown) => sql.prepare("INSERT INTO books VALUES (?, ?, ?, ?, ?)")
    .run(id, typeof data === "string" ? data : JSON.stringify(data ?? { id, title: `书籍 ${id}`, author: "真实作者", chapterOutline: [{ id: "chapter-a", title: "第一章" }], createdAt: now,
      aiApiKey: "SHOULD_NOT_EXPORT", coverDataUrl: "SHOULD_NOT_EXPORT", chapters: "SHOULD_NOT_EXPORT" }), now, v, deleted ? now : null);
  const note = (id: string, bookId: string, v: number, deleted = false, data?: unknown) => sql.prepare("INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, bookId, typeof data === "string" ? data : JSON.stringify(data ?? { id, bookId, kind: "highlight", chapterId: "chapter-a", sentenceId: `sentence-${id}`, excerpt: `摘录 ${id}`, thought: "我的想法", groupId: "cross-sentence", createdAt: now, aiApiKey: "SHOULD_NOT_EXPORT" }), now, v, deleted ? now : null);
  const chat = (bookId: string, v: number, data?: unknown) => sql.prepare("INSERT INTO chats VALUES (?, ?, ?, ?)")
    .run(bookId, typeof data === "string" ? data : JSON.stringify(data ?? { bookId, turns: [{ id: "q", role: "user", content: "为什么？", quote: "引用原文", private: "SHOULD_NOT_EXPORT" },
      { id: "a", replyTo: "q", role: "assistant", content: "这是回答。", reasoning: "保存的思考", model: "grok", error: "内部错误不应导出" }], aiApiKey: "SHOULD_NOT_EXPORT" }), now, v);
  const request = (path: string, token?: string, init: RequestInit = {}) => new Request(`https://test/api/knowledge/v1${path}`, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers } });
  const syncRequest = (path: string, cookie = "", body?: unknown, headers: Record<string, string> = {}) => new Request(`https://test/api/sync/${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { cookie, ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const login = async () => {
    const result = await handleSync(syncRequest("login", "", { username: env.SYNC_USERNAME, password: env.SYNC_PASSWORD }), env);
    assert.equal(result.status, 200);
    return result.headers.get("set-cookie")!.split(";")[0];
  };
  const key = async (cookie?: string) => {
    const response = await handleSync(syncRequest("access-keys", cookie ?? await login(), { name: "Grok test", expiresInDays: 30 }), env);
    assert.equal(response.status, 201);
    return await response.json() as { token: string; key: { id: string; expiresAt: number } };
  };
  return { sql, db, env, blobs, book, note, chat, request, syncRequest, login, key, now };
}

test("专用密钥只保存哈希且不会再次返回；同步会话和 Bot 授权互不通用", async () => {
  const s = setup(); const cookie = await s.login(); const key = await s.key(cookie);
  const stored = s.sql.prepare("SELECT * FROM knowledge_api_keys").get()!;
  assert.equal(stored.token_hash, await recordHash(key.token));
  assert.ok(!JSON.stringify(stored).includes(key.token));
  const list = await handleSync(s.syncRequest("access-keys", cookie), s.env);
  const data = await list.text(); assert.ok(!data.includes(key.token)); assert.ok(!data.includes("token_hash"));
  assert.equal((await handleKnowledgeApi(s.request("/books", undefined, { headers: { cookie } }), s.env)).status, 401);
  assert.equal((await handleSync(s.syncRequest("access-keys", "", undefined, { authorization: `Bearer ${key.token}` }), s.env)).status, 401);
  assert.equal((await handleSync(s.syncRequest("push", "", {}, { authorization: `Bearer ${key.token}` }), s.env)).status, 401);
  assert.equal((await handleKnowledgeApi(s.request("/books", cookie.split("=")[1]), s.env)).status, 401);
  s.sql.close();
});

test("匿名、错误、到期、撤销密钥均拒绝，返回不缓存的标准 Bearer 错误", async () => {
  const s = setup(); const cookie = await s.login(); const key = await s.key(cookie);
  for (const token of [undefined, "invalid", "moting_ro_" + "a".repeat(43)]) {
    const result = await handleKnowledgeApi(s.request("/notes", token), s.env);
    assert.equal(result.status, 401); assert.equal(result.headers.get("cache-control"), "no-store"); assert.match(result.headers.get("www-authenticate")!, /Bearer/);
  }
  assert.equal((await handleKnowledgeApi(s.request("/notes", key.token), s.env)).status, 200);
  assert.ok(s.sql.prepare("SELECT last_used_at FROM knowledge_api_keys").get()!.last_used_at);
  s.sql.prepare("UPDATE knowledge_api_keys SET expires_at = 1").run();
  assert.equal((await handleKnowledgeApi(s.request("/notes", key.token), s.env)).status, 401);
  s.sql.prepare("UPDATE knowledge_api_keys SET expires_at = ?").run(Date.now() + 100000);
  assert.equal((await handleSync(s.syncRequest(`access-keys/${key.key.id}/revoke`, cookie, {}), s.env)).status, 200);
  assert.equal((await handleKnowledgeApi(s.request("/notes", key.token), s.env)).status, 401);
  s.sql.close();
});

test("接口完全只读；密钥管理拒绝跨站和匿名，旧域名代理也先检查 Origin", async () => {
  const s = setup(); const cookie = await s.login(); const key = await s.key(cookie);
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD"]) {
    const result = await handleKnowledgeApi(s.request("/notes", key.token, { method }), s.env);
    assert.equal(result.status, 405); assert.equal(result.headers.get("allow"), "GET");
  }
  assert.equal((await handleSync(s.syncRequest("access-keys"), s.env)).status, 401);
  assert.equal((await handleSync(s.syncRequest("access-keys", cookie, { name: "bad" }, { origin: "https://evil.test" }), s.env)).status, 403);
  assert.equal((await forwardSync(s.syncRequest("access-keys", cookie, { name: "bad" }, { origin: "https://evil.test" }), "https://unused.test")).status, 403);
  s.sql.close();
});

test("只读字段投影包含想法、章节和跨句组，过滤删除书和笔记", async () => {
  const s = setup(); s.book("alive", 1); s.book("deleted", 2, true);
  s.note("first", "alive", 3); s.note("removed", "alive", 4, true); s.note("orphan", "deleted", 5);
  s.chat("alive", 6); s.chat("deleted", 7);
  const { token } = await s.key();
  const books = await (await handleKnowledgeApi(s.request("/books", token), s.env)).json() as { data: { id: string }[] };
  assert.deepEqual(books.data.map((row) => row.id), ["alive"]);
  const notes = await (await handleKnowledgeApi(s.request("/notes", token), s.env)).json() as { data: Record<string, unknown>[] };
  assert.equal(notes.data.length, 1); assert.equal(notes.data[0].thought, "我的想法"); assert.equal(notes.data[0].chapterTitle, "第一章"); assert.equal(notes.data[0].groupId, "cross-sentence");
  const chats = await (await handleKnowledgeApi(s.request("/chats", token), s.env)).json() as { data: { bookId: string }[] };
  assert.deepEqual(chats.data.map((row) => row.bookId), ["alive"]);
  const detail = await (await handleKnowledgeApi(s.request("/chats/alive", token), s.env)).json() as { turns: Record<string, unknown>[] };
  assert.equal(detail.turns[0].quote, "引用原文"); assert.equal(detail.turns[1].content, "这是回答。"); assert.equal(detail.turns[1].reasoning, "保存的思考"); assert.equal(detail.turns[1].incomplete, true);
  for (const result of [books, notes, chats, detail]) assert.ok(!JSON.stringify(result).includes("SHOULD_NOT_EXPORT"));
  assert.ok(!JSON.stringify(detail).includes("内部错误"));
  assert.equal((await handleKnowledgeApi(s.request("/chats/deleted", token), s.env)).status, 404);
  s.sql.close();
});

test("键排序分页不漏重复版本记录，关键词过滤的空页可以继续", async () => {
  const s = setup(); s.book("book", 1);
  s.note("a", "book", 3, false, { excerpt: "不匹配", thought: "", kind: "highlight" });
  s.note("b", "book", 3, false, { excerpt: "匹配词中文", thought: "独立想法", kind: "highlight" });
  s.note("c", "book", 4, false, { excerpt: "匹配词中文", thought: "", kind: "listening-mark" });
  const { token } = await s.key();
  const ids: string[] = []; let cursor: string | null = null;
  do {
    const result = await (await handleKnowledgeApi(s.request(`/notes?limit=1${cursor ? `&cursor=${cursor}` : ""}`, token), s.env)).json() as { data: { id: string }[]; nextCursor: string | null };
    ids.push(...result.data.map((row) => row.id)); cursor = result.nextCursor;
  } while (cursor);
  assert.deepEqual(ids, ["a", "b", "c"]);
  const first = await (await handleKnowledgeApi(s.request("/notes?limit=1&q=匹配词", token), s.env)).json() as { data: unknown[]; nextCursor: string };
  assert.deepEqual(first.data, []); assert.ok(first.nextCursor);
  const second = await (await handleKnowledgeApi(s.request(`/notes?limit=1&q=匹配词&cursor=${first.nextCursor}`, token), s.env)).json() as { data: { id: string }[] };
  assert.equal(second.data[0].id, "b");
  assert.equal((await handleKnowledgeApi(s.request(`/notes?limit=1&q=其他&cursor=${first.nextCursor}`, token), s.env)).status, 400);
  const thoughts = await (await handleKnowledgeApi(s.request("/notes?thoughtsOnly=true&kind=highlight&bookId=book", token), s.env)).json() as { data: { id: string }[] };
  assert.deepEqual(thoughts.data.map((row) => row.id), ["b"]);
  const none = await (await handleKnowledgeApi(s.request(`/notes?updatedSince=${s.now}`, token), s.env)).json() as { data: unknown[] };
  assert.deepEqual(none.data, []);
  s.sql.close();
});

test("列表固定已提交上界，下一轮可以读取分页中发生的更新", async () => {
  const s = setup(); s.book("book", 1); s.note("a", "book", 2); s.note("b", "book", 3);
  const { token } = await s.key();
  const first = await (await handleKnowledgeApi(s.request("/notes?limit=1", token), s.env)).json() as { nextCursor: string };
  s.note("later", "book", 10001); s.sql.prepare("UPDATE sync_meta SET value = 10001").run();
  const rest = await (await handleKnowledgeApi(s.request(`/notes?cursor=${first.nextCursor}`, token), s.env)).json() as { data: { id: string }[] };
  assert.deepEqual(rest.data.map((row) => row.id), ["b"]);
  const again = await (await handleKnowledgeApi(s.request("/notes", token), s.env)).json() as { data: { id: string }[] };
  assert.deepEqual(again.data.map((row) => row.id), ["a", "b", "later"]);
  s.sql.close();
});

test("对话按原顺序完整分页，并发修改返回 409 要求重读", async () => {
  const s = setup(); s.book("book", 1); s.chat("book", 2);
  const { token } = await s.key();
  const first = await (await handleKnowledgeApi(s.request("/chats/book?limit=1", token), s.env)).json() as { turns: { role: string }[]; nextCursor: string };
  assert.equal(first.turns[0].role, "user");
  const second = await (await handleKnowledgeApi(s.request(`/chats/book?limit=1&cursor=${first.nextCursor}`, token), s.env)).json() as { turns: { role: string }[]; nextCursor: string | null };
  assert.equal(second.turns[0].role, "assistant"); assert.equal(second.nextCursor, null);
  s.sql.prepare("UPDATE chats SET server_at = 3").run();
  const changed = await handleKnowledgeApi(s.request(`/chats/book?cursor=${first.nextCursor}`, token), s.env);
  assert.equal(changed.status, 409); assert.equal((await changed.json() as { error: { code: string } }).error.code, "conversation_changed");
  s.sql.close();
});

test("R2 大对话及书目和笔记引用能读取、搜索，缺失或校验失败明确报错", async () => {
  const s = setup();
  const store = async (kind: string, id: string, value: unknown) => {
    const data = JSON.stringify(value); const hash = await recordHash(data);
    s.blobs.set(recordObjectKey(kind, id, hash), data);
    return { pointer: STORED_BLOB_PREFIX + JSON.stringify({ hash, bytes: utf8Bytes(data) }), path: recordObjectKey(kind, id, hash), data };
  };
  const meta = await store("books", "large", { title: "大型对话的书", author: "作者", coverDataUrl: "SHOULD_NOT_EXPORT" }); s.book("large", 1, false, meta.pointer);
  const note = await store("notes", "note", { excerpt: "大笔记", thought: "大的想法", kind: "highlight" }); s.note("note", "large", 2, false, note.pointer);
  const long = "完整长对话。".repeat(60000);
  const chat = await store("chats", "large", { turns: [{ role: "user", content: "R2关键词" }, { role: "assistant", content: long }] }); s.chat("large", 3, chat.pointer);
  const { token } = await s.key();
  const search = await (await handleKnowledgeApi(s.request("/chats?q=R2关键词", token), s.env)).json() as { data: unknown[] }; assert.equal(search.data.length, 1);
  const detail = await (await handleKnowledgeApi(s.request("/chats/large", token), s.env)).json() as { turns: { content: string }[]; bookTitle: string };
  assert.equal(detail.turns[1].content, long); assert.equal(detail.bookTitle, "大型对话的书");
  const notes = await (await handleKnowledgeApi(s.request("/notes?thoughtsOnly=true&q=大的想法", token), s.env)).json() as { data: unknown[] }; assert.equal(notes.data.length, 1);
  s.blobs.delete(chat.path); assert.equal((await handleKnowledgeApi(s.request("/chats/large", token), s.env)).status, 503);
  s.blobs.set(chat.path, chat.data.replace("R2关键词", "R3关键词")); assert.equal((await handleKnowledgeApi(s.request("/chats/large", token), s.env)).status, 503);
  s.sql.close();
});

test("参数验证拒绝越界、跨资源游标、重复参数和注入；查询文本按字面匹配", async () => {
  const s = setup(); s.book("book", 1); s.note("a", "book", 2); const { token } = await s.key();
  for (const path of ["/notes?limit=0", "/notes?limit=101", "/notes?limit=1.5", "/notes?cursor=bad", "/notes?updatedSince=-1", "/notes?bookId=' OR 1=1", "/notes?thoughtsOnly=yes", "/notes?limit=1&limit=2", "/books?kind=highlight", "/notes?unknown=1"]) {
    assert.equal((await handleKnowledgeApi(s.request(path, token), s.env)).status, 400, path);
  }
  const result = await (await handleKnowledgeApi(s.request("/notes?q=%25_", token), s.env)).json() as { data: unknown[] }; assert.deepEqual(result.data, []);
  assert.equal((await handleKnowledgeApi(s.request("/settings", token), s.env)).status, 404);
  s.sql.close();
});

test("10 个密钥上限及有效期校验，撤销后允许再创建", async () => {
  const s = setup(); const cookie = await s.login(); const first = await s.key(cookie);
  for (let i = 0; i < 9; i++) await s.key(cookie);
  assert.equal((await handleSync(s.syncRequest("access-keys", cookie, { name: "too-many" }), s.env)).status, 409);
  assert.equal((await handleSync(s.syncRequest(`access-keys/${first.key.id}/revoke`, cookie, {}), s.env)).status, 200);
  await s.key(cookie);
  for (const body of [{ name: "" }, { name: "a", expiresInDays: 1 }, { name: "a", expiresInDays: "365" }]) assert.equal((await handleSync(s.syncRequest("access-keys", cookie, body), s.env)).status, 400);
  const oversize = new Request("https://test/api/sync/access-keys", { method: "POST", headers: { cookie }, body: "a".repeat(4097) });
  assert.equal((await handleSync(oversize, s.env)).status, 413);
  s.sql.close();
});

test("OpenAPI 公开且不含私有数据，未配置服务返回明确 503", async () => {
  const s = setup();
  const spec = await (await handleKnowledgeApi(s.request("/openapi.json"), {})).json() as { openapi: string; paths: Record<string, unknown>; components: { securitySchemes: { bearerAuth: { scheme: string } } } };
  assert.equal(spec.openapi, "3.1.0"); assert.equal(spec.components.securitySchemes.bearerAuth.scheme, "bearer");
  assert.deepEqual(Object.keys(spec.paths), ["/books", "/notes", "/chats", "/chats/{bookId}"]);
  assert.equal((await handleKnowledgeApi(s.request("/notes"), {})).status, 503);
  s.sql.close();
});

test("旧入口代理透传 Bearer 和认证响应头，不透传上游敏感头", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "https://primary.test/api/knowledge/v1/notes?limit=5");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-test-token");
      return new Response("{}", { status: 401, headers: { "www-authenticate": "Bearer", "x-private": "not-forwarded" } });
    };
    const result = await forwardSync(new Request("https://legacy.test/api/knowledge/v1/notes?limit=5", { headers: { authorization: "Bearer synthetic-test-token" } }), "https://primary.test");
    assert.equal(result.status, 401); assert.equal(result.headers.get("www-authenticate"), "Bearer"); assert.equal(result.headers.get("x-private"), null);
  } finally { globalThis.fetch = original; }
});
