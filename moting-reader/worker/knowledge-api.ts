import { APP_BUILD } from "../lib/build-info.ts";
import { KNOWLEDGE_API_PATH } from "../lib/knowledge-api.ts";
import { MAX_RECORD_BYTES, recordHash, recordObjectKey, storedBlob, utf8Bytes } from "../lib/sync-record.ts";
import { authorizeKnowledge, KnowledgeError, knowledgeFailure, knowledgeJson } from "./knowledge-keys.ts";
import { knowledgeOpenApi } from "./knowledge-openapi.ts";

type Json = Record<string, unknown>;
type Resource = "books" | "notes" | "chats";
interface Row { id: string; book_id: string; data: string; updated_at: number; server_at: number }
interface ListCursor { type: "list"; resource: Resource; at: number; id: string; through: number; filter: string }
interface ChatCursor { type: "chat"; bookId: string; version: number; offset: number }
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PAGE_BYTES = 8 * 1024 * 1024;
// 大对话每页重读/重解析会触发线上 Workers 1102。只复用已校验、版本未变的 R2 内容，
// 每次仍检查对象存在及版本；授权和 D1 删除状态始终由请求重新检查。
const CHAT_CACHE_BYTES = 12 * 1024 * 1024;
const chatCache = new Map<string, { version: string; bytes: number; value: Json }>();
let chatCacheBytes = 0;

function forgetChat(key: string): void {
  const entry = chatCache.get(key);
  if (entry) { chatCacheBytes -= entry.bytes; chatCache.delete(key); }
}

function rememberChat(key: string, entry: { version: string; bytes: number; value: Json }): void {
  forgetChat(key);
  while (chatCacheBytes + entry.bytes > CHAT_CACHE_BYTES && chatCache.size) forgetChat(chatCache.keys().next().value!);
  chatCache.set(key, entry);
  chatCacheBytes += entry.bytes;
}

function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new KnowledgeError("云端记录格式异常，请稍后重试", 503, "invalid_record");
  return value as Json;
}
function encodeCursor(value: ListCursor | ChatCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeCursor(value: string): Json {
  try {
    if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return object(JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))));
  } catch { throw new KnowledgeError("分页游标无效，请从第一页重新读取"); }
}
function integer(value: string | null, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw new KnowledgeError("分页或时间参数需为非负整数");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > max) throw new KnowledgeError("分页或时间参数超出范围");
  return number;
}
function checkParams(params: URLSearchParams, allowed: string[]): void {
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) throw new KnowledgeError(`查询参数无效：${key.slice(0, 60)}`);
}
function pageLimit(params: URLSearchParams): number {
  const limit = integer(params.get("limit"), 50, 100);
  if (limit < 1) throw new KnowledgeError("limit 需为 1–100");
  return limit;
}

async function readRecord(kind: Resource, key: string, data: string, bucket?: R2Bucket): Promise<Json> {
  const blob = storedBlob(data);
  let source = data;
  let cacheKey = "";
  let objectVersion = "";
  if (blob) {
    if (!bucket) throw new KnowledgeError("大记录存储暂时不可用", 503, "unavailable");
    const objectKey = recordObjectKey(kind, key, blob.hash);
    cacheKey = kind === "chats" ? objectKey : "";
    const cached = cacheKey ? chatCache.get(cacheKey) : undefined;
    if (cached) {
      const current = await bucket.head(objectKey);
      if (!current || current.size !== blob.bytes) {
        forgetChat(cacheKey);
        throw new KnowledgeError("大记录正文暂时不可用，请稍后重试", 503, "unavailable");
      }
      if (current.version === cached.version) {
        rememberChat(cacheKey, cached);
        return cached.value;
      }
      forgetChat(cacheKey);
    }
    const saved = await bucket.get(objectKey);
    if (!saved || saved.size !== blob.bytes || saved.size > MAX_RECORD_BYTES) throw new KnowledgeError("大记录正文暂时不可用，请稍后重试", 503, "unavailable");
    objectVersion = saved.version;
    source = await new Response(saved.body).text();
    if (utf8Bytes(source) !== blob.bytes || await recordHash(source) !== blob.hash) throw new KnowledgeError("大记录正文校验失败，请稍后重试", 503, "invalid_record");
  }
  try {
    const value = object(JSON.parse(source));
    if (blob && cacheKey && objectVersion && blob.bytes <= CHAT_CACHE_BYTES) {
      rememberChat(cacheKey, { version: objectVersion, bytes: blob.bytes, value });
    }
    return value;
  }
  catch (error) {
    if (error instanceof KnowledgeError) throw error;
    throw new KnowledgeError("云端记录内容异常，请稍后重试", 503, "invalid_record");
  }
}

function bookInfo(id: string, meta: Json, updatedAt: number): Json {
  return { id, title: text(meta.title), author: text(meta.author),
    chapterCount: Array.isArray(meta.chapterOutline) ? meta.chapterOutline.length : 0,
    createdAt: typeof meta.createdAt === "number" ? meta.createdAt : null, updatedAt };
}
function noteInfo(row: Row, note: Json, book: Json): Json {
  const chapters = Array.isArray(book.chapterOutline) ? book.chapterOutline : [];
  const chapter = chapters.find((item) => item && typeof item === "object" && item.id === note.chapterId);
  const result: Json = { id: row.id, bookId: row.book_id, bookTitle: text(book.title),
    chapterId: text(note.chapterId), chapterTitle: text(chapter?.title), sentenceId: text(note.sentenceId),
    kind: text(note.kind), excerpt: text(note.excerpt), thought: text(note.thought),
    groupId: text(note.groupId) || row.id, createdAt: typeof note.createdAt === "number" ? note.createdAt : null,
    updatedAt: row.updated_at, version: row.server_at };
  for (const key of ["start", "end"]) if (typeof note[key] === "number") result[key] = note[key];
  for (const key of ["color", "highlightStyle"]) if (typeof note[key] === "string") result[key] = note[key];
  return result;
}
function chatTurns(chat: Json): unknown[] {
  if (!Array.isArray(chat.turns)) throw new KnowledgeError("云端对话格式异常", 503, "invalid_record");
  return chat.turns;
}
function turnInfo(value: unknown, index: number): Json {
  const turn = object(value);
  if (turn.role !== "user" && turn.role !== "assistant" || typeof turn.content !== "string") throw new KnowledgeError("云端对话轮次格式异常", 503, "invalid_record");
  const result: Json = { index, role: turn.role, content: turn.content, incomplete: Boolean(turn.error) };
  for (const key of ["id", "replyTo", "quote", "model", "reasoning"]) if (typeof turn[key] === "string") result[key] = turn[key];
  return result;
}

async function list(request: Request, db: D1Database, bucket: R2Bucket | undefined, resource: Resource): Promise<Response> {
  const params = new URL(request.url).searchParams;
  checkParams(params, ["limit", "cursor", "bookId", "q", "updatedSince", "thoughtsOnly", "kind"]);
  if (resource !== "notes" && (params.has("thoughtsOnly") || params.has("kind"))) throw new KnowledgeError("thoughtsOnly、kind 只适用于 notes");
  const limit = pageLimit(params);
  const bookId = params.get("bookId") ?? "";
  if (bookId && !ID_PATTERN.test(bookId)) throw new KnowledgeError("bookId 无效");
  const q = (params.get("q") ?? "").trim().toLowerCase();
  if (q.length > 200) throw new KnowledgeError("关键词不能超过 200 个字符");
  const since = integer(params.get("updatedSince"), 0);
  const thoughts = params.get("thoughtsOnly");
  if (thoughts !== null && thoughts !== "true" && thoughts !== "false") throw new KnowledgeError("thoughtsOnly 需为 true 或 false");
  const kind = params.get("kind") ?? "";
  if (kind && kind !== "highlight" && kind !== "listening-mark") throw new KnowledgeError("kind 无效");
  const filter = await recordHash(JSON.stringify([resource, bookId, q, since, thoughts === "true", kind]));
  const clock = await db.prepare("SELECT value FROM sync_meta WHERE key = 'server_clock'").first<{ value: number }>();
  let cursor: ListCursor = { type: "list", resource, at: 0, id: "", through: clock?.value ?? 0, filter };
  if (params.has("cursor")) {
    const raw = decodeCursor(params.get("cursor")!);
    if (raw.type !== "list" || raw.resource !== resource || raw.filter !== filter ||
      !Number.isSafeInteger(raw.at) || Number(raw.at) < 0 || !Number.isSafeInteger(raw.through) || Number(raw.through) < Number(raw.at) ||
      typeof raw.id !== "string" || !ID_PATTERN.test(raw.id) || Number(raw.through) > (clock?.value ?? 0)) throw new KnowledgeError("分页游标与查询条件不匹配，请重新读取");
    cursor = raw as unknown as ListCursor;
  }
  const idColumn = resource === "chats" ? "r.book_id" : "r.id";
  const bookColumn = resource === "books" ? "r.id" : "r.book_id";
  const dataColumn = resource === "books" ? "r.meta" : "r.data";
  const tombstone = resource === "chats" ? "" : "AND r.deleted_at IS NULL";
  const join = resource === "books" ? "" : "JOIN books b ON b.id = r.book_id AND b.deleted_at IS NULL";
  const bindings: (string | number)[] = [cursor.at, cursor.at, cursor.id, cursor.through, since];
  if (bookId) bindings.push(bookId);
  bindings.push(limit + 1);
  const candidates = (await db.prepare(`SELECT ${idColumn} AS id, ${bookColumn} AS book_id, ${dataColumn} AS data, r.updated_at, r.server_at
    FROM ${resource} r ${join} WHERE (r.server_at > ? OR (r.server_at = ? AND ${idColumn} > ?))
    AND r.server_at <= ? AND r.updated_at > ? ${tombstone} ${bookId ? `AND ${bookColumn} = ?` : ""}
    ORDER BY r.server_at, ${idColumn} LIMIT ?`).bind(...bindings).all<Row>()).results;
  const metas = new Map<string, Json>();
  if (resource !== "books" && candidates.length) {
    const ids = [...new Set(candidates.slice(0, limit).map((row) => row.book_id))];
    const books = (await db.prepare(`SELECT id, meta FROM books WHERE deleted_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids).all<{ id: string; meta: string }>()).results;
    for (const row of books) {
      const meta = await readRecord("books", row.id, row.meta, bucket);
      metas.set(row.id, { title: text(meta.title), chapterOutline: resource === "notes" ? meta.chapterOutline : [] });
    }
  }
  const data: Json[] = [];
  let scanned = 0;
  let bytes = 0;
  for (const row of candidates.slice(0, limit)) {
    const size = storedBlob(row.data)?.bytes ?? utf8Bytes(row.data);
    if (scanned > 0 && bytes + size > PAGE_BYTES) break;
    const value = await readRecord(resource, row.id, row.data, bucket);
    let item: Json;
    let matches: boolean;
    if (resource === "books") {
      item = { ...bookInfo(row.id, value, row.updated_at), version: row.server_at };
      matches = !q || `${item.title}\n${item.author}`.toLowerCase().includes(q);
    } else if (resource === "notes") {
      item = noteInfo(row, value, metas.get(row.book_id) ?? {});
      matches = (!kind || item.kind === kind) && (thoughts !== "true" || Boolean(text(item.thought).trim())) &&
        (!q || `${item.excerpt}\n${item.thought}\n${item.bookTitle}`.toLowerCase().includes(q));
    } else {
      const turns = chatTurns(value);
      const bookTitle = text(metas.get(row.book_id)?.title);
      item = { bookId: row.book_id, bookTitle, updatedAt: row.updated_at, version: row.server_at, turnCount: turns.length,
        detailPath: `${KNOWLEDGE_API_PATH}/chats/${encodeURIComponent(row.book_id)}` };
      matches = !q || bookTitle.toLowerCase().includes(q) || turns.some((value) => {
        const turn = object(value);
        return [turn.content, turn.quote, turn.reasoning].some((part) => text(part).toLowerCase().includes(q));
      });
    }
    if (matches) data.push(item);
    bytes += size;
    scanned += 1;
    cursor.at = row.server_at;
    cursor.id = row.id;
  }
  return knowledgeJson({ data, nextCursor: candidates.length > scanned ? encodeCursor(cursor) : null,
    syncVersion: cursor.through, syncedOnly: true });
}

async function chatDetail(request: Request, db: D1Database, bucket: R2Bucket | undefined, bookId: string): Promise<Response> {
  if (!ID_PATTERN.test(bookId)) throw new KnowledgeError("bookId 无效");
  const params = new URL(request.url).searchParams;
  checkParams(params, ["limit", "cursor"]);
  const limit = pageLimit(params);
  const row = await db.prepare(`SELECT c.data, c.updated_at, c.server_at, b.meta FROM chats c
    JOIN books b ON b.id = c.book_id AND b.deleted_at IS NULL WHERE c.book_id = ?`)
    .bind(bookId).first<{ data: string; updated_at: number; server_at: number; meta: string }>();
  if (!row) throw new KnowledgeError("云端没有这本书的对话", 404, "not_found");
  let offset = 0;
  if (params.has("cursor")) {
    const cursor = decodeCursor(params.get("cursor")!);
    if (cursor.type !== "chat" || cursor.bookId !== bookId || !Number.isSafeInteger(cursor.offset) || Number(cursor.offset) < 0) throw new KnowledgeError("对话分页游标无效");
    if (cursor.version !== row.server_at) throw new KnowledgeError("对话已更新，请从第一页重新读取", 409, "conversation_changed");
    offset = Number(cursor.offset);
  }
  const bookTitle = text((await readRecord("books", bookId, row.meta, bucket)).title);
  const chat = await readRecord("chats", bookId, row.data, bucket);
  const source = chatTurns(chat);
  if (offset > source.length) throw new KnowledgeError("对话分页位置无效");
  const turns: Json[] = [];
  let bytes = 0;
  for (let index = offset; index < Math.min(source.length, offset + limit); index++) {
    const turn = turnInfo(source[index], index);
    const size = utf8Bytes(JSON.stringify(turn));
    if (turns.length > 0 && bytes + size > PAGE_BYTES) break;
    turns.push(turn);
    bytes += size;
  }
  offset += turns.length;
  return knowledgeJson({ bookId, bookTitle, updatedAt: row.updated_at, version: row.server_at,
    totalTurns: source.length, turns, nextCursor: offset < source.length ? encodeCursor({ type: "chat", bookId, version: row.server_at, offset }) : null,
    syncedOnly: true });
}

export async function handleKnowledgeApi(request: Request, env: { DB?: D1Database; BOOKS_BUCKET?: R2Bucket }): Promise<Response> {
  try {
    if (request.method !== "GET") return knowledgeJson({ error: { code: "method_not_allowed", message: "AI 数据接口只支持 GET 读取" } }, 405, { allow: "GET" });
    const url = new URL(request.url);
    const action = url.pathname.slice(KNOWLEDGE_API_PATH.length);
    if (action === "/openapi.json") return knowledgeJson(knowledgeOpenApi(url.origin));
    if (!env.DB) throw new KnowledgeError("此部署未启用 AI 数据接口", 503, "unavailable");
    await authorizeKnowledge(request, env.DB);
    if (action === "" || action === "/") return knowledgeJson({ name: "墨听 AI 数据接口", version: "1.0.0", build: APP_BUILD,
      scope: "knowledge:read", resources: ["books", "notes", "chats"], syncedOnly: true, openapi: `${KNOWLEDGE_API_PATH}/openapi.json` });
    if (action === "/books" || action === "/notes" || action === "/chats") return await list(request, env.DB, env.BOOKS_BUCKET, action.slice(1) as Resource);
    const match = /^\/chats\/([^/]+)$/.exec(action);
    if (match) return await chatDetail(request, env.DB, env.BOOKS_BUCKET, match[1]);
    throw new KnowledgeError("接口不存在", 404, "not_found");
  } catch (error) { return knowledgeFailure(error); }
}
