// 云端同步服务端:登录会话 + 记录级 LWW 增量同步 + R2 正文/插图存取。
// 合并语义:所有记录按客户端声明的 updated_at 比较,新者胜;删除走墓碑。
// 没有任何「整库覆盖」路径——手机首次同步是上传,另一台设备首次同步是拉取合并。
// 持久化经注入的 SyncStore(生产 createD1Store,测试内存实现),R2 经 env.BOOKS_BUCKET。
import { createD1Store, D1_PARAM_BYTES, packedRowBytes, type PushRow, type SyncRow, type SyncStore, type SyncTable } from "./sync-store.ts";

type Json = Record<string, unknown>;

export interface SyncEnv {
  DB?: D1Database;
  BOOKS_BUCKET?: R2Bucket;
  SYNC_USERNAME?: string;
  SYNC_PASSWORD?: string;
  /** 测试注入;缺省时由 env.DB 生成 D1 store。 */
  store?: SyncStore;
}

const SESSION_COOKIE = "moting_sync";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
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

async function readBody(request: Request, limit: number): Promise<Json> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > limit) throw new SyncError("请求数据过大", 413);
  const text = await request.text();
  if (text.length > limit) throw new SyncError("请求数据过大", 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SyncError("请求数据无效", 400);
  }
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

async function validSession(request: Request, store: SyncStore): Promise<boolean> {
  const token = sessionToken(request);
  if (!TOKEN_PATTERN.test(token)) return false;
  const expiresAt = await store.getSession(await sha256Hex(token));
  return expiresAt !== null && expiresAt > Date.now();
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
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const cookie = `${SESSION_COOKIE}=${token}; Path=/api/sync; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`;
  return json({ connected: true }, 200, cookie);
}

interface ParsedPush {
  table: SyncTable;
  row: PushRow;
}

/**
 * 单条 push 记录的解析:键格式、时间戳合理性。墓碑允许无 data、无 bookId。
 * 体积不在这里判:超过 D1 单行上限的记录由 handlePush 跳过并回报,不拖垮整批。
 */
function parsePushItem(raw: unknown, config: (typeof TABLES)[string], now: number): ParsedPush {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SyncError("push 记录格式不对");
  const item = raw as Json;
  const key = typeof item.key === "string" ? item.key : "";
  if (!key || !config.keyPattern.test(key)) throw new SyncError("记录键无效");
  const updatedAt = Number(item.updatedAt);
  if (!Number.isInteger(updatedAt) || updatedAt <= 0 || updatedAt > now + MAX_CLOCK_SKEW_MS) {
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
  return {
    table: config.table,
    row: { key, data, updatedAt, deletedAt: config.tombstones ? deletedAt : null, bookId },
  };
}

async function handlePush(request: Request, { store }: Resolved): Promise<Response> {
  if (!(await validSession(request, store))) return json({ error: "请先登录同步账号" }, 401);
  const now = Date.now();
  const body = await readBody(request, PUSH_BODY_LIMIT);

  const accepted: ParsedPush[] = [];
  const tooLarge: Record<string, string[]> = {};
  for (const [name, config] of Object.entries(TABLES)) {
    const list = body[name];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list) || list.length > PUSH_ITEM_LIMIT) throw new SyncError(`${name} 记录数无效`);
    for (const raw of list) {
      const parsed = parsePushItem(raw, config, now);
      const { row } = parsed;
      // D1 单个参数/单行上限 2 MB:超了的记录跳过并回报,其余照常入库。
      const bytes = packedRowBytes({ i: 0, k: row.key, d: row.data, u: row.updatedAt, x: row.deletedAt, b: row.bookId });
      if (bytes > D1_PARAM_BYTES - 2) {
        (tooLarge[name] ??= []).push(row.key);
        continue;
      }
      accepted.push(parsed);
    }
  }
  if (accepted.length > PUSH_ITEM_LIMIT) throw new SyncError("单次上传记录过多");
  await store.applyPush(accepted);
  return json({ tooLarge });
}

/**
 * 增量拉取,跨表按 server_at 统一分页。server_at 全库单调唯一,
 * 所以「各表各取前 N+1 条 → 合并排序 → 取前 N 条」得到的正是全局前 N 条;
 * 下一页从最后一条的 server_at + 1 开始,不重不漏。
 */
async function handlePull(request: Request, { store }: Resolved): Promise<Response> {
  if (!(await validSession(request, store))) return json({ error: "请先登录同步账号" }, 401);
  const body = await readBody(request, 4096);
  const since = Number(body.since ?? 0);
  if (!Number.isSafeInteger(since) || since < 0) throw new SyncError("同步水位无效");

  const candidates: Array<{ name: string; row: SyncRow }> = [];
  for (const [name, config] of Object.entries(TABLES)) {
    for (const row of await store.since(config.table, since, PULL_PAGE_ROWS + 1)) candidates.push({ name, row });
  }
  candidates.sort((a, b) => a.row.serverAt - b.row.serverAt);

  const result: Json = {};
  for (const name of Object.keys(TABLES)) result[name] = [];
  let taken = 0;
  let bytes = 0;
  let cursor = since;
  for (const { name, row } of candidates) {
    if (taken >= PULL_PAGE_ROWS || (taken > 0 && bytes + row.data.length > PULL_PAGE_BYTES)) break;
    let data: unknown = null;
    if (row.data) {
      try {
        data = JSON.parse(row.data);
      } catch {
        data = null;
      }
    }
    const item: Json = { key: row.key, updatedAt: row.updatedAt };
    if (data !== null) item.data = data;
    if (row.deletedAt) item.deletedAt = row.deletedAt;
    (result[name] as Json[]).push(item);
    taken += 1;
    bytes += row.data.length;
    cursor = row.serverAt + 1;
  }
  result.cursor = cursor;
  result.hasMore = taken < candidates.length;
  return json(result);
}

function contentKey(bookId: string): string {
  return `books/${bookId}/content.json`;
}

function imageKey(bookId: string, imageId: string): string {
  return `books/${bookId}/images/${imageId}`;
}

async function handleBookContent(request: Request, { store, bucket }: Resolved, bookId: string): Promise<Response> {
  if (!(await validSession(request, store))) return json({ error: "请先登录同步账号" }, 401);
  if (!SYNC_KEY_PATTERN.test(bookId)) return json({ error: "书籍编号无效" }, 400);
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
  return json({ error: "只支持 GET 或 POST 请求" }, 405);
}

async function handleBookImage(
  request: Request,
  { store, bucket }: Resolved,
  bookId: string,
  imageId: string
): Promise<Response> {
  if (!(await validSession(request, store))) return json({ error: "请先登录同步账号" }, 401);
  if (!SYNC_KEY_PATTERN.test(bookId) || !SYNC_KEY_PATTERN.test(imageId)) return json({ error: "书籍或插图编号无效" }, 400);
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
  return json({ error: "只支持 GET 或 POST 请求" }, 405);
}

export async function handleSync(request: Request, env: SyncEnv): Promise<Response> {
  try {
    if (request.method !== "GET" && request.method !== "POST") return json({ error: "只支持 GET 或 POST 请求" }, 405);
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
      return json({ connected: await validSession(request, resolved.store), enabled: true });
    }

    const resolved = resolve(env);
    if (request.method === "POST" && action === "login") return await handleLogin(request, env, resolved);
    if (request.method === "POST" && action === "logout") {
      const token = sessionToken(request);
      if (TOKEN_PATTERN.test(token)) await resolved.store.dropSession(await sha256Hex(token));
      const secure = url.protocol === "https:" ? "; Secure" : "";
      const cookie = `${SESSION_COOKIE}=; Path=/api/sync; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
      return json({ connected: false }, 200, cookie);
    }
    if (request.method === "POST" && action === "push") return await handlePush(request, resolved);
    if (request.method === "POST" && action === "pull") return await handlePull(request, resolved);
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
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(180_000)]),
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
