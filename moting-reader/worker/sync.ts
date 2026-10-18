import { handleAudioStream } from "./audio-stream.ts";
import { APP_BUILD, SYNC_PROTOCOL } from "../lib/build-info.ts";
import { handleLiveHls } from "./live-hls.ts";
import { handleHls } from "./hls.ts";
import { synthesizeSpeech } from "./edge-tts.ts";
// 云端同步服务端:登录会话 + 记录级 LWW 增量同步 + R2 正文/插图存取。
// 合并语义:所有记录按客户端声明的 updated_at 比较,新者胜;删除走墓碑。
// 没有任何「整库覆盖」路径——手机首次同步是上传,另一台设备首次同步是拉取合并。
// 持久化经注入的 SyncStore(生产 createD1Store,测试内存实现),R2 经 env.BOOKS_BUCKET。
import { createD1Store, D1_PARAM_BYTES, packedRowBytes, type PushRow, type SyncRow, type SyncStore, type SyncTable } from "./sync-store.ts";

import { INLINE_RECORD_BYTES, MAX_RECORD_BYTES, STORED_BLOB_PREFIX, isRecordBlob, storedBlob,
  recordHash, recordObjectKey, utf8Bytes, type RecordIssue, type RecordReceipt } from "../lib/sync-record.ts";
import type { ProgressReceipt } from "../lib/sync-progress.ts";

type Json = Record<string, unknown>;

export interface SyncEnv {
  DB?: D1Database;
  BOOKS_BUCKET?: R2Bucket;
  AUDIO_QUEUE?: Queue<import("./live-hls.ts").LiveHlsJob>;
  SYNC_USERNAME?: string;
  SYNC_PASSWORD?: string;
  /** 测试注入;缺省时由 env.DB 生成 D1 store。 */
  store?: SyncStore;
}

const SESSION_COOKIE = "moting_sync";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
// 滑动续期:距上次续期超过一天才写库、重发 cookie,不让每次同步都多一次 D1 写。
// 只要 30 天内同步过一次,就永远不用重新登录。
const SESSION_RENEW_AFTER_MS = 24 * 3600 * 1000;
const PUSH_ITEM_LIMIT = 500;
// 一页 pull 的条数与字节预算。页满就带 hasMore 返回,客户端拿 cursor 接着拉。
const PULL_PAGE_ROWS = 300;
const PULL_PAGE_BYTES = 8 * 1024 * 1024;
const PUSH_BODY_LIMIT = 32 * 1024 * 1024;
const MAX_SYNC_CONTENT_BYTES = 50 * 1024 * 1024;
const MAX_SYNC_IMAGE_BYTES = 10 * 1024 * 1024;
const SYNC_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SETTING_KEY_PATTERN = /^[a-z][a-z-]{0,31}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
// 允许 1 天的客户端时钟偏差,但不接受过于未来的时间戳,防止把 LWW 永久锁死。
const MAX_CLOCK_SKEW_MS = 24 * 3600 * 1000;

// push/pull 里每一类的表配置:key 校验、是否带 book_id。
const TABLES: Record<string, { table: SyncTable; tombstones: boolean; needsBookId: boolean; keyPattern: RegExp }> = {
  books: { table: "books", tombstones: true, needsBookId: false, keyPattern: SYNC_KEY_PATTERN },
  notes: { table: "notes", tombstones: true, needsBookId: true, keyPattern: SYNC_KEY_PATTERN },
  positions: { table: "positions", tombstones: false, needsBookId: false, keyPattern: SYNC_KEY_PATTERN },
  sessions: { table: "sessions", tombstones: false, needsBookId: false, keyPattern: SYNC_KEY_PATTERN },
  settings: { table: "settings", tombstones: false, needsBookId: false, keyPattern: SETTING_KEY_PATTERN },
  chats: { table: "chats", tombstones: false, needsBookId: false, keyPattern: SYNC_KEY_PATTERN },
  patches: { table: "patches", tombstones: false, needsBookId: false, keyPattern: SYNC_KEY_PATTERN },
  listening: { table: "listening", tombstones: false, needsBookId: false, keyPattern: SYNC_KEY_PATTERN },
};

class SyncError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function json(data: unknown, status = 200, cookie?: string): Response {
  const headers: Record<string, string> = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (cookie) headers["set-cookie"] = cookie;
  return Response.json(data, { status, headers });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readLimitedText(request: Request, limit: number): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new SyncError("请求数据过大", 413);
  const reader = request.body?.getReader();
  if (!reader) return "";
  const parts: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new SyncError("请求数据过大", 413); }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
  } finally { reader.releaseLock(); }
  return parts.join("");
}

async function readBody(request: Request, limit: number): Promise<Json> {
  const text = await readLimitedText(request, limit);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new SyncError("请求数据无效", 400); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyncError("请求数据格式不对", 400);
  return parsed as Json;
}

function sessionToken(request: Request): string {
  const cookies = request.headers.get("cookie") || "";
  for (const entry of cookies.split(";")) {
    const [name, ...rest] = entry.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return "";
}

function sessionCookie(request: Request, token: string, maxAgeSeconds: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/api/sync; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

interface SessionCheck {
  ok: boolean;
  /** 续期时要带回给浏览器的新 cookie;浏览器那边的有效期不续,服务端续了也没用。 */
  cookie?: string;
}

async function checkSession(request: Request, store: SyncStore): Promise<SessionCheck> {
  const token = sessionToken(request);
  if (!TOKEN_PATTERN.test(token)) return { ok: false };
  const hash = await sha256Hex(token);
  const expiresAt = await store.getSession(hash);
  const now = Date.now();
  if (expiresAt === null || expiresAt <= now) return { ok: false };
  if (expiresAt - now > SESSION_TTL_MS - SESSION_RENEW_AFTER_MS) return { ok: true };
  await store.renewSession(hash, now + SESSION_TTL_MS);
  return { ok: true, cookie: sessionCookie(request, token, SESSION_TTL_MS / 1000) };
}

interface Resolved {
  store: SyncStore;
  bucket: R2Bucket;
}

function resolve(env: SyncEnv): Resolved {
  const store = env.store ?? (env.DB ? createD1Store(env.DB) : null);
  if (!store || !env.BOOKS_BUCKET) throw new SyncError("此部署未启用云端同步", 503);
  return { store, bucket: env.BOOKS_BUCKET };
}

async function handleLogin(request: Request, env: SyncEnv, { store }: Resolved): Promise<Response> {
  if (!env.SYNC_USERNAME || !env.SYNC_PASSWORD) return json({ error: "同步账号未配置,请联系部署者" }, 503);
  const body = await readBody(request, 4096);
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password || username.length > 256 || password.length > 256) {
    return json({ error: "请输入用户名和密码" }, 400);
  }
  const [gotUser, wantUser, gotPass, wantPass] = await Promise.all([
    sha256Hex(username), sha256Hex(env.SYNC_USERNAME), sha256Hex(password), sha256Hex(env.SYNC_PASSWORD),
  ]);
  if (gotUser !== wantUser || gotPass !== wantPass) return json({ error: "用户名或密码不正确" }, 401);
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const now = Date.now();
  await store.pruneSessions(now);
  await store.addSession(await sha256Hex(token), now + SESSION_TTL_MS);
  return json({ connected: true }, 200, sessionCookie(request, token, SESSION_TTL_MS / 1000));
}

interface ParsedPush {
  table: SyncTable;
  row: PushRow;
}

/**
 * 单条 push 记录的解析:键格式、时间戳合理性。墓碑允许无 data、无 bookId。
 * 这里抛的错只让这一条被跳过(handlePush 收进 rejected 回报),不拖垮整批——
 * 否则一条坏记录(比如时钟快了一天的设备写的)会让之后每一轮同步都失败。
 */
function parsePushItem(raw: unknown, config: (typeof TABLES)[string], now: number): ParsedPush {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SyncError("push 记录格式不对");
  const item = raw as Json;
  const key = typeof item.key === "string" ? item.key : "";
  if (!key || !config.keyPattern.test(key)) throw new SyncError("记录键无效");
  const updatedAt = Number(item.updatedAt);
  const isProgress = config.table === "positions" || config.table === "listening";
  const modern = isProgress && typeof item.mutationId === "string";
  if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0 || (!modern && updatedAt > now + MAX_CLOCK_SKEW_MS)) {
    throw new SyncError("记录时间戳无效");
  }
  let deletedAt: number | null = null;
  if (item.deletedAt !== undefined && item.deletedAt !== null) {
    if (!Number.isInteger(Number(item.deletedAt)) || Number(item.deletedAt) <= 0) throw new SyncError("墓碑时间无效");
    deletedAt = Number(item.deletedAt);
  }
  let data = "";
  if (!deletedAt) {
    if (typeof item.data !== "string" || !item.data) throw new SyncError("记录内容缺失");
    data = item.data;
  }
  let bookId: string | null = null;
  if (config.needsBookId && !deletedAt) {
    const rawBookId = typeof item.bookId === "string" ? item.bookId : "";
    if (!rawBookId || !SYNC_KEY_PATTERN.test(rawBookId)) throw new SyncError("记录缺少有效的书籍编号");
    bookId = rawBookId;
  }
  if (modern) {
    if (!TOKEN_PATTERN.test(String(item.mutationId)) || !Number.isSafeInteger(item.baseServerRev) || Number(item.baseServerRev) < 0) {
      throw new SyncError("进度确认版本无效");
    }
    let value: Json;
    try { value = JSON.parse(data) as Json; } catch { throw new SyncError("进度内容无效"); }
    const position = config.table === "positions" ? value?.position as Json : value;
    if (!position || typeof position.sentenceId !== "string" || typeof position.chapterId !== "string" ||
        !Number.isInteger(position.chapterIndex) || Number(position.chapterIndex) < 0 ||
        !Number.isInteger(position.sentenceIndex) || Number(position.sentenceIndex) < 0 ||
        typeof position.percent !== "number" || !Number.isFinite(position.percent) ||
        typeof position.updatedAt !== "number" || !Number.isFinite(position.updatedAt)) {
      throw new SyncError("进度位置无效");
    }
    if (config.table === "positions" && (!Number.isFinite(value.savedAt) || !Number.isFinite(value.lastOpenedAt))) {
      throw new SyncError("阅读位置无效");
    }
  }
  return {
    table: config.table,
    row: { key, data, updatedAt, deletedAt: config.tombstones ? deletedAt : null, bookId,
      ...(modern ? { mutationId: String(item.mutationId), baseServerRev: Number(item.baseServerRev), bootstrap: item.bootstrap === true } : {}) },
  };
}

async function handlePush(request: Request, { store, bucket }: Resolved): Promise<Response> {
  const session = await checkSession(request, store);
  if (!session.ok) return json({ error: "请先登录同步账号" }, 401);
  const now = Date.now();
  const body = await readBody(request, PUSH_BODY_LIMIT);
  let count = 0;
  for (const name of Object.keys(TABLES)) {
    const list = body[name];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list) || list.length > PUSH_ITEM_LIMIT) throw new SyncError(`${name} 记录数无效`);
    count += list.length;
  }
  if (count > PUSH_ITEM_LIMIT) throw new SyncError("单次上传记录过多");

  const accepted: ParsedPush[] = [];
  const tooLarge: Record<string, string[]> = {};
  const rejected: Record<string, string[]> = {};
  const issues: RecordIssue[] = [];
  for (const [name, config] of Object.entries(TABLES)) {
    for (const raw of (body[name] ?? []) as unknown[]) {
      let bytes = 0;
      try {
        const item = raw && typeof raw === "object" ? raw as Json : {};
        const progress = name === "positions" || name === "listening";
        const blob = item.blob;
        if (blob !== undefined && (progress || !isRecordBlob(blob))) throw new SyncError("大记录引用无效");
        // 引用使用非 JSON 前缀，用户提交的 JSON 正文无法伪装成存储指针。
        const prepared = isRecordBlob(blob) ? { ...item, data: STORED_BLOB_PREFIX + JSON.stringify(blob) } : raw;
        const parsed = parsePushItem(prepared, config, now);
        const { row } = parsed;
        if (!row.deletedAt) {
          if (isRecordBlob(blob)) {
            bytes = blob.bytes;
            const object = await bucket.head(recordObjectKey(name, row.key, blob.hash));
            if (!object || object.size !== blob.bytes) throw new SyncError("大记录正文尚未上传完成", 503);
          } else {
            bytes = utf8Bytes(row.data);
            if (bytes > MAX_RECORD_BYTES) throw new SyncError("单条记录超过 32 MB 同步上限", 413);
            try { JSON.parse(row.data); } catch { throw new SyncError("记录内容不是有效的 JSON"); }
            const packed = packedRowBytes({ i: 0, k: row.key, d: row.data, u: row.updatedAt, x: row.deletedAt, b: row.bookId });
            if (progress && packed > D1_PARAM_BYTES - 2) throw new SyncError("进度记录过大，请重新定位后同步", 413);
            if (!progress && (bytes > INLINE_RECORD_BYTES || packed > D1_PARAM_BYTES - 2)) {
              const hash = await recordHash(row.data);
              const objectKey = recordObjectKey(name, row.key, hash);
              if (!(await bucket.head(objectKey))) await bucket.put(objectKey, row.data, {
                httpMetadata: { contentType: "application/json" },
              });
              row.data = STORED_BLOB_PREFIX + JSON.stringify({ hash, bytes });
              console.info("sync_record_offloaded", { kind: name, key: row.key, bytes });
            }
          }
        }
        accepted.push(parsed);
      } catch (error) {
        const item = raw && typeof raw === "object" ? raw as Json : {};
        const key = typeof item.key === "string" ? item.key.slice(0, 64) : "";
        const status = error instanceof SyncError ? error.status : 503;
        const reason = error instanceof SyncError ? error.message : "大记录存储暂时失败，稍后自动重试";
        const code = status === 413 ? "record_too_large" : status >= 500 ? "storage_unavailable" : "invalid_record";
        (status === 413 ? tooLarge : rejected)[name] ??= [];
        (status === 413 ? tooLarge : rejected)[name].push(key);
        const issue: RecordIssue = { kind: name as RecordIssue["kind"], key, updatedAt: Number(item.updatedAt) || 0,
          code, reason, bytes, retryable: status >= 500 };
        issues.push(issue);
        console.warn("sync_push_issue", { kind: name, key, code, bytes, retryable: issue.retryable });
      }
    }
  }
  // 先持久化不可变 R2 对象，再提交 D1 引用。D1 失败时只留下可幂等复用的对象。
  const allReceipts = await store.applyPush(accepted);
  const receipts = allReceipts.filter((receipt): receipt is ProgressReceipt => receipt.kind === "positions" || receipt.kind === "listening");
  const recordReceipts = allReceipts.filter((receipt): receipt is RecordReceipt => receipt.kind !== "positions" && receipt.kind !== "listening");
  if (receipts.some((receipt) => receipt.status === "upgrade")) {
    return json({ error: "同步协议已升级，请更新应用后重试；本机进度仍保留", upgradeRequired: true }, 426, session.cookie);
  }
  for (const receipt of recordReceipts) {
    const sent = accepted.find((entry) => entry.table === receipt.kind && entry.row.key === receipt.key && entry.row.updatedAt === receipt.updatedAt);
    const blob = sent ? storedBlob(sent.row.data) : null;
    if (blob) console.info("sync_record_confirmed", { kind: receipt.kind, key: receipt.key,
      status: receipt.status, bytes: blob.bytes, serverAt: receipt.serverAt });
  }
  return json({ tooLarge, rejected, receipts, recordReceipts, issues }, 200, session.cookie);
}

async function handleRecord(request: Request, { store, bucket }: Resolved, kind: string, key: string, hash: string): Promise<Response> {
  const session = await checkSession(request, store);
  if (!session.ok) return json({ error: "请先登录同步账号" }, 401);
  const config = TABLES[kind];
  if (!config || kind === "positions" || kind === "listening" || !config.keyPattern.test(key) || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new SyncError("记录地址无效");
  }
  const objectKey = recordObjectKey(kind, key, hash);
  const headers: Record<string, string> = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (session.cookie) headers["set-cookie"] = session.cookie;
  if (request.method === "HEAD") {
    const object = await bucket.head(objectKey);
    return new Response(null, { status: object ? 200 : 404, headers: { ...headers, "x-record-bytes": String(object?.size ?? 0) } });
  }
  if (request.method === "GET") {
    const object = await bucket.get(objectKey);
    if (!object) throw new SyncError("大记录正文暂时不可用，稍后自动重试", 503);
    if (object.size > MAX_RECORD_BYTES) throw new SyncError("大记录正文超过上限", 413);
    return new Response(object.body, { headers: { ...headers, "content-type": "application/json" } });
  }
  const data = await readLimitedText(request, MAX_RECORD_BYTES);
  try { JSON.parse(data); } catch { throw new SyncError("记录内容不是有效的 JSON"); }
  if (await recordHash(data) !== hash) throw new SyncError("记录内容校验失败");
  if (!(await bucket.head(objectKey))) await bucket.put(objectKey, data, { httpMetadata: { contentType: "application/json" } });
  return json({ stored: true, hash, bytes: utf8Bytes(data) }, 200, session.cookie);
}

/**
 * 增量拉取,跨表按 server_at 统一分页。先固定一个已提交上界，再查询每张表；
 * 并发写入会落在这个上界之后，不能在某张表已查完后插进本页并被游标越过。
 */
async function handlePull(request: Request, { store, bucket }: Resolved): Promise<Response> {
  const session = await checkSession(request, store);
  if (!session.ok) return json({ error: "请先登录同步账号" }, 401);
  const body = await readBody(request, 4096);
  const since = Number(body.since ?? 0);
  if (!Number.isSafeInteger(since) || since < 0) throw new SyncError("同步水位无效");
  const through = await store.latestServerAt();

  const candidates: Array<{ name: string; row: SyncRow }> = [];
  for (const [name, config] of Object.entries(TABLES)) {
    if (body.progressOnly === true && name !== "positions" && name !== "listening") continue;
    for (const row of await store.since(config.table, since, through, PULL_PAGE_ROWS + 1)) candidates.push({ name, row });
  }
  candidates.sort((a, b) => a.row.serverAt - b.row.serverAt);

  const result: Json = {};
  for (const name of Object.keys(TABLES)) result[name] = [];
  let taken = 0;
  let bytes = 0;
  let cursor = since;
  for (const { name, row } of candidates) {
    if (taken >= PULL_PAGE_ROWS) break;
    const blob = storedBlob(row.data);
    // 引用页也按展开后的体积限额，接收端不会一次解开数百个大正文。
    if (taken > 0 && bytes + (blob?.bytes ?? utf8Bytes(row.data)) > PULL_PAGE_BYTES) break;
    const item: Json = { key: row.key, updatedAt: row.updatedAt, serverAt: row.serverAt };
    if (row.mutationId) item.mutationId = row.mutationId;
    if (row.deletedAt) item.deletedAt = row.deletedAt;
    if (blob && body.recordBlobs === true) item.blob = blob;
    else if (row.data) {
      let text = row.data;
      if (blob) {
        if (taken > 0 && bytes + blob.bytes > PULL_PAGE_BYTES) break;
        const object = await bucket.get(recordObjectKey(name, row.key, blob.hash));
        if (!object || object.size !== blob.bytes) throw new SyncError("大记录正文暂时不可用，稍后自动重试", 503);
        text = await new Response(object.body).text();
        if (await recordHash(text) !== blob.hash) throw new SyncError("大记录正文校验失败", 503);
      }
      try { item.data = JSON.parse(text); }
      catch { throw new SyncError("云端记录内容异常，请稍后重试", 503); }
    }
    const itemBytes = utf8Bytes(JSON.stringify(item));
    if (taken > 0 && bytes + itemBytes > PULL_PAGE_BYTES) break;
    (result[name] as Json[]).push(item);
    taken += 1;
    bytes += Math.max(itemBytes, blob?.bytes ?? 0);
    cursor = row.serverAt + 1;
  }
  result.hasMore = taken < candidates.length;
  result.cursor = result.hasMore ? cursor : Math.max(cursor, through + 1);
  return json(result, 200, session.cookie);
}

function contentKey(bookId: string): string {
  return `books/${bookId}/content.json`;
}

function imageKey(bookId: string, imageId: string): string {
  return `books/${bookId}/images/${imageId}`;
}

async function handleBookContent(request: Request, { store, bucket }: Resolved, bookId: string): Promise<Response> {
  if (!(await checkSession(request, store)).ok) return json({ error: "请先登录同步账号" }, 401);
  if (!SYNC_KEY_PATTERN.test(bookId)) return json({ error: "书籍编号无效" }, 400);
  if (request.method === "HEAD") {
    const exists = await bucket.head(contentKey(bookId));
    return new Response(null, { status: exists ? 200 : 404, headers: { "cache-control": "no-store" } });
  }
  if (request.method === "GET") {
    const object = await bucket.get(contentKey(bookId));
    if (!object || !object.body) return json({ error: "云端没有这本书的正文" }, 404);
    if (object.size > MAX_SYNC_CONTENT_BYTES) return json({ error: "正文超出同步上限" }, 413);
    return new Response(object.body, {
      headers: { "cache-control": "no-store", "content-type": "application/json", "x-content-type-options": "nosniff" },
    });
  }
  if (request.method === "POST") {
    if (await bucket.head(contentKey(bookId))) return json({ error: "这本书的正文已在云端" }, 409);
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_SYNC_CONTENT_BYTES) {
      return json({ error: "正文超出同步上限,请压缩或拆分后再同步" }, 413);
    }
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_SYNC_CONTENT_BYTES) return json({ error: "正文超出同步上限,请压缩或拆分后再同步" }, 413);
    if (body.byteLength === 0) return json({ error: "正文内容为空" }, 400);
    const head = new TextDecoder().decode(body.slice(0, 1));
    if (head !== "[" && head !== "{") return json({ error: "正文内容不是有效 JSON" }, 400);
    await bucket.put(contentKey(bookId), body, { httpMetadata: { contentType: "application/json" } });
    return json({ stored: true });
  }
  return json({ error: "只支持 GET、HEAD 或 POST 请求" }, 405);
}

async function handleBookImage(
  request: Request,
  { store, bucket }: Resolved,
  bookId: string,
  imageId: string
): Promise<Response> {
  if (!(await checkSession(request, store)).ok) return json({ error: "请先登录同步账号" }, 401);
  if (!SYNC_KEY_PATTERN.test(bookId) || !SYNC_KEY_PATTERN.test(imageId)) return json({ error: "书籍或插图编号无效" }, 400);
  if (request.method === "HEAD") {
    const exists = await bucket.head(imageKey(bookId, imageId));
    return new Response(null, { status: exists ? 200 : 404, headers: { "cache-control": "no-store" } });
  }
  if (request.method === "GET") {
    const object = await bucket.get(imageKey(bookId, imageId));
    if (!object || !object.body) return json({ error: "云端没有这张插图" }, 404);
    return new Response(object.body, {
      headers: {
        "cache-control": "no-store",
        "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (request.method === "POST") {
    if (await bucket.head(imageKey(bookId, imageId))) return json({ stored: true });
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_SYNC_IMAGE_BYTES) {
      return json({ error: "插图超出同步上限" }, 413);
    }
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_SYNC_IMAGE_BYTES) return json({ error: "插图超出同步上限" }, 413);
    if (body.byteLength === 0) return json({ error: "插图内容为空" }, 400);
    await bucket.put(imageKey(bookId, imageId), body, {
      httpMetadata: { contentType: request.headers.get("content-type") ?? "application/octet-stream" },
    });
    return json({ stored: true });
  }
  return json({ error: "只支持 GET、HEAD 或 POST 请求" }, 405);
}

export async function handleSync(request: Request, env: SyncEnv, ctx?: ExecutionContext): Promise<Response> {
  try {
    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
      return json({ error: "只支持 GET、HEAD 或 POST 请求" }, 405);
    }
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) return json({ error: "不允许跨站请求" }, 403);
    const url = new URL(request.url);
    const action = url.pathname.replace("/api/sync/", "");

    // session 探测不要求资源就绪:未启用同步的部署要能明确回答 enabled:false。
    if (action === "session") {
      let resolved: Resolved | null = null;
      try {
        resolved = resolve(env);
      } catch {
        resolved = null;
      }
      if (!resolved) return json({ connected: false, enabled: false });
      const session = await checkSession(request, resolved.store);
      return json({ connected: session.ok, enabled: true, protocol: SYNC_PROTOCOL, build: APP_BUILD, backend: "moting-sync" }, 200, session.cookie);
    }

    const resolved = resolve(env);
    if (request.method === "GET" && action === "version") {
      const session = await checkSession(request, resolved.store);
      if (!session.ok) return json({ error: "请先登录同步账号" }, 401);
      return json({ version: await resolved.store.latestServerAt(), protocol: SYNC_PROTOCOL, build: APP_BUILD }, 200, session.cookie);
    }
    if (request.method === "POST" && action === "login") return await handleLogin(request, env, resolved);
    if (request.method === "POST" && action === "logout") {
      const token = sessionToken(request);
      if (TOKEN_PATTERN.test(token)) await resolved.store.dropSession(await sha256Hex(token));
      return json({ connected: false }, 200, sessionCookie(request, "", 0));
    }
    if (action.startsWith("audio-stream/")) {
      const session = await checkSession(request, resolved.store);
      if (!session.ok) return json({ error: "请先在设置里登录云端同步" }, 401);
      const response = await handleAudioStream(request, resolved.bucket, ctx);
      if (session.cookie) response.headers.set("set-cookie", session.cookie);
      return response;
    }
    if (action.startsWith("live/")) {
      const session = await checkSession(request, resolved.store);
      if (!session.ok) return json({ error: "请先在设置里登录云端同步" }, 401);
      const response = await handleLiveHls(request, resolved.bucket, env.AUDIO_QUEUE, ctx, env.DB);
      if (session.cookie) response.headers.set("set-cookie", session.cookie);
      return response;
    }
    if (action.startsWith("hls/")) {
      const session = await checkSession(request, resolved.store);
      if (!session.ok) return json({ error: "请先在设置里登录云端同步，再准备 HLS 音频" }, 401);
      const response = await handleHls(request, resolved.bucket, synthesizeSpeech);
      if (session.cookie) response.headers.set("set-cookie", session.cookie);
      return response;
    }
    if (request.method === "POST" && action === "push") return await handlePush(request, resolved);
    if (request.method === "POST" && action === "pull") return await handlePull(request, resolved);
    const recordMatch = /^record\/([^/]+)\/([^/]+)\/([a-f0-9]{64})$/.exec(action);
    if (recordMatch) return await handleRecord(request, resolved, recordMatch[1], decodeURIComponent(recordMatch[2]), recordMatch[3]);
    const contentMatch = /^book\/([^/]+)\/content$/.exec(action);
    if (contentMatch) return await handleBookContent(request, resolved, decodeURIComponent(contentMatch[1]));
    const imageMatch = /^book\/([^/]+)\/images\/([^/]+)$/.exec(action);
    if (imageMatch) {
      return await handleBookImage(request, resolved, decodeURIComponent(imageMatch[1]), decodeURIComponent(imageMatch[2]));
    }
    return json({ error: "接口不存在" }, 404);
  } catch (error) {
    const status = error instanceof SyncError ? error.status : 502;
    if (!(error instanceof SyncError)) console.warn("sync_request_failed", { status });
    return json({ error: error instanceof SyncError ? error.message : "同步服务暂时不可用,请稍后重试" }, status);
  }
}

/**
 * 旧域名部署的反向代理:/api/sync/* 原样转发到主部署。
 * 凭据 Cookie 由这条通道双向透传,客户端永远只见到同源地址。
 * 正文下载/上传走流式转发,不落 Worker 内存。
 */
export async function forwardSync(request: Request, upstream: string): Promise<Response> {
  const url = new URL(request.url);
  let target: URL;
  try {
    target = new URL(url.pathname + url.search, upstream);
  } catch {
    return json({ error: "同步服务配置无效" }, 502);
  }
  const headers = new Headers();
  for (const name of ["content-type", "cookie", "content-length"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  let response: Response;
  try {
    response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
      // 比客户端最长的等待(正文上传 300 秒)再宽一点,慢网上传大书时不能先被这一层掐断。
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(330_000)]),
    });
  } catch (error) {
    if (request.signal.aborted) throw error;
    return json({ error: "暂时连不上同步服务,请稍后重试" }, 503);
  }
  const out = new Response(response.body, {
    status: response.status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
  const contentType = response.headers.get("content-type");
  if (contentType) out.headers.set("content-type", contentType);
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) out.headers.set("set-cookie", setCookie);
  return out;
}
