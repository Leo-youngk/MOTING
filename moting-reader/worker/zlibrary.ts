// 协议参考：bipinkrish/Zlibrary-API 与 ZlibraryKO/zlibrary.koplugin。
// 独立的 Web Fetch 实现；凭据仅用于用户指定的站点，不转交下载 CDN。
import { MAX_BOOK_FILE_ERROR } from "../lib/file-limits.ts";
import { ONLINE_BOOK_FORMATS, ONLINE_BOOK_MAX_BYTES, ZLIBRARY_ORIGIN, type OnlineBook } from "../lib/zlibrary-types.ts";

type Json = Record<string, unknown>;
type Fetcher = typeof fetch;
const PAGE_SIZE = 20;
const SEARCH_TIMEOUT_MS = 15_000;
const SEARCH_RETRY_DELAY_MS = 250;
const COOKIE_ID = "moting_zlib_id";
const COOKIE_KEY = "moting_zlib_key";
const RETRYABLE_UPSTREAM_STATUS = new Set([408, 425, 500, 502, 503, 504]);

interface ApiOptions {
  timeoutMs?: number;
  retryTransient?: boolean;
}

class ServiceError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}
function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function message(data: Json): string {
  const errors = Array.isArray(data.errors) ? data.errors : [];
  return text(object(data.response).message || object(data.error).message || data.error || data.message || object(errors[0]).message || errors[0])
    .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 350);
}
function failUpstream(data: Json, fallback: string): never {
  const detail = message(data);
  if (/login|log in|sign in|unauth|登录|session.*expir/i.test(detail)) throw new ServiceError("请先登录 Z-Library，或重新登录已过期的账号", 401);
  if (/password|credential|密码/i.test(detail)) throw new ServiceError("邮箱或密码不正确，请重新输入", 401);
  if (/limit|quota|限额|上限/i.test(detail)) throw new ServiceError(`Z-Library 暂时不允许下载${detail ? `：${detail}` : ""}`, 429);
  throw new ServiceError(detail ? `Z-Library：${detail}` : fallback);
}

function session(request: Request): { id: string; key: string } | null {
  const cookies = new Map((request.headers.get("cookie") || "").split(";").map((entry) => {
    const [name, ...rest] = entry.trim().split("=");
    return [name, rest.join("=")];
  }));
  const id = cookies.get(COOKIE_ID) || "";
  const key = cookies.get(COOKIE_KEY) || "";
  return /^\d{1,20}$/.test(id) && /^[a-zA-Z0-9_-]{8,256}$/.test(key) ? { id, key } : null;
}

function setSession(response: Response, request: Request, value: { id: string; key: string } | null): Response {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  for (const [name, val] of [[COOKIE_ID, value?.id || ""], [COOKIE_KEY, value?.key || ""]]) {
    response.headers.append("set-cookie", `${name}=${val}; Path=/api/zlibrary; HttpOnly; SameSite=Strict; Max-Age=${value ? 2592000 : 0}${secure}`);
  }
  return response;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

/** 有上限地读取 JSON；不让站点错误页或未知响应占满 Worker 内存。 */
async function readJson(response: Response, limit: number): Promise<Json> {
  if (!response.body) throw new ServiceError("服务返回了空响应");
  const reader = response.body.getReader();
  let size = 0;
  const decoder = new TextDecoder();
  let body = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new ServiceError("服务返回的数据过大");
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid JSON object");
    return parsed as Json;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof ServiceError) throw error;
    throw new ServiceError("Z-Library 未返回有效接口数据，可能需要网站验证，请稍后重试");
  } finally {
    reader.releaseLock();
  }
}

function waitForRetry(request: Request, delayMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (request.signal.aborted) {
      reject(request.signal.reason ?? new DOMException("请求已取消", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      request.signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(request.signal.reason ?? new DOMException("请求已取消", "AbortError"));
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function api(path: string, request: Request, fetcher: Fetcher, form?: URLSearchParams, options: ApiOptions = {}): Promise<Json> {
  const credentials = session(request);
  const headers = new Headers({
    accept: "application/json, text/javascript, */*; q=0.01",
    "accept-language": "zh-CN,zh;q=0.9",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    origin: ZLIBRARY_ORIGIN,
    referer: `${ZLIBRARY_ORIGIN}/`,
  });
  headers.set("cookie", `siteLanguageV2=zh${credentials ? `; remix_userid=${credentials.id}; remix_userkey=${credentials.key}` : ""}`);
  if (credentials) {
    // 部分 EAPI 入口只读取请求头，部分入口只读取 Cookie；两种都带上才能保持登录会话。
    headers.set("remix-userid", credentials.id);
    headers.set("remix-userkey", credentials.key);
  }
  if (form) {
    headers.set("content-type", "application/x-www-form-urlencoded; charset=UTF-8");
    headers.set("x-requested-with", "XMLHttpRequest");
  }

  const maxAttempts = options.retryTransient ? 2 : 1;
  const timeoutMs = options.timeoutMs ?? 25_000;
  const body = form?.toString();
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetcher(`${ZLIBRARY_ORIGIN}${path}`, {
        method: form ? "POST" : "GET",
        headers,
        body,
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (error) {
      if (request.signal.aborted) throw error;
      if (attempt + 1 < maxAttempts) {
        console.warn("zlibrary_upstream_retry", { path, attempt: attempt + 1, reason: "network" });
        await waitForRetry(request, SEARCH_RETRY_DELAY_MS);
        continue;
      }
      throw new ServiceError("暂时连接不上 zh.z-lib.gd，请稍后重试", 503);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new ServiceError("Z-Library 要求跳转到其他页面，当前接口暂时不可用");
    }
    if (!response.ok) {
      const retryable = options.retryTransient && RETRYABLE_UPSTREAM_STATUS.has(response.status);
      if (retryable && attempt + 1 < maxAttempts) {
        await response.body?.cancel();
        console.warn("zlibrary_upstream_retry", { path, attempt: attempt + 1, reason: `http_${response.status}` });
        await waitForRetry(request, SEARCH_RETRY_DELAY_MS);
        continue;
      }
      await response.body?.cancel();
      if (response.status === 401) throw new ServiceError("请先登录 Z-Library", 401);
      if (response.status === 429) throw new ServiceError("Z-Library 请求或下载次数已达上限，请稍后重试", 429);
      throw new ServiceError(`Z-Library 返回 ${response.status}${response.status === 403 ? "，当前请求被网站拦截" : "，请稍后重试"}`);
    }
    const data = await readJson(response, 2 * 1024 * 1024);
    if (data.success === false || data.success === 0 || data.error) failUpstream(data, "Z-Library 未能完成请求");
    return data;
  }
  throw new ServiceError("Z-Library 请求失败，请稍后重试");
}

function normalizeBook(raw: unknown): OnlineBook | null {
  const book = object(raw);
  const id = text(book.id), hash = text(book.hash), title = text(book.title).trim();
  if (!/^\d+$/.test(id) || !/^[a-zA-Z0-9]+$/.test(hash) || !title) return null;
  const bytes = Number(book.filesize);
  let cover = "";
  try {
    const url = new URL(text(book.cover), ZLIBRARY_ORIGIN);
    if (book.cover && url.protocol === "https:" && !url.username && !url.password) cover = url.href;
  } catch { /* 无有效封面时 UI 显示“暂无封面”。 */ }
  return { id, hash, title, author: text(book.author), extension: text(book.extension).toLowerCase(), language: text(book.language), year: text(book.year), bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : null, size: text(book.filesizeString) || (bytes > 0 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : ""), cover };
}

/** 文件地址只能由固定站点的 file 接口给出，不接受客户端提交 URL。 */
function downloadUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw, ZLIBRARY_ORIGIN); } catch { throw new ServiceError("下载地址无效"); }
  const host = url.hostname;
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !host.includes(".") || /(^\d+\.\d+\.\d+\.\d+$)|[:\[\]]|\.(localhost|local|internal|test|invalid)$/i.test(host) || host.endsWith(".")) throw new ServiceError("站点返回了不受支持的下载地址");
  return url;
}

async function download(request: Request, payload: Json, fetcher: Fetcher): Promise<Response> {
  const id = text(payload.id), hash = text(payload.hash);
  if (!/^\d{1,20}$/.test(id) || !/^[a-zA-Z0-9]{1,64}$/.test(hash)) throw new ServiceError("书籍编号无效", 400);
  const data = await api(`/eapi/book/${id}/${hash}/file`, request, fetcher);
  const file = object(data.file);
  if (!file.downloadLink) {
    const detail = text(file.disallowDownloadMessage).replace(/<[^>]*>/g, " ").slice(0, 300);
    if (file.allowDownload === false) throw new ServiceError(detail ? `Z-Library 暂不允许下载：${detail}` : "Z-Library 暂不允许下载，请检查账号的剩余下载次数", 429);
    failUpstream(data, "Z-Library 没有提供文件下载地址，请登录后重试");
  }
  const extension = text(file.extension).toLowerCase();
  if (!(ONLINE_BOOK_FORMATS as readonly string[]).includes(extension)) throw new ServiceError("这个版本的格式暂不支持，请选择 EPUB、PDF、TXT 或 Markdown", 422);
  let url = downloadUrl(text(file.downloadLink));
  let response: Response | undefined;
  for (let hop = 0; hop < 5; hop++) {
    try {
      response = await fetcher(url.href, { redirect: "manual", signal: AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]) });
    } catch { throw new ServiceError("文件服务器连接失败，请重试", 503); }
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new ServiceError("下载跳转缺少地址");
    url = downloadUrl(new URL(location, url).href);
    response = undefined;
  }
  if (!response?.ok || !response.body) {
    await response?.body?.cancel();
    throw new ServiceError("文件下载失败或跳转过多，请重试");
  }
  const type = response.headers.get("content-type") || "application/octet-stream";
  const length = Number(response.headers.get("content-length")) || 0;
  if (/html|json/i.test(type) || length > ONLINE_BOOK_MAX_BYTES) {
    await response.body.cancel();
    throw new ServiceError(length > ONLINE_BOOK_MAX_BYTES ? MAX_BOOK_FILE_ERROR : "下载返回了网页而非书籍文件，请重新登录后重试", 422);
  }
  const filename = `${text(file.description).replace(/[<>:"/\\|?*\x00-\x1f]/g, " ").trim().slice(0, 140) || id}.${extension}`;
  const headers = new Headers({ "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "x-book-filename": encodeURIComponent(filename), "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` });
  // 流式转发；即便没有 Content-Length，也在读取时执行大小上限。
  let received = 0;
  const limited = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > ONLINE_BOOK_MAX_BYTES) throw new Error(MAX_BOOK_FILE_ERROR);
      controller.enqueue(chunk);
    },
    flush() {
      if (!received || (length && !response?.headers.get("content-encoding") && received !== length)) throw new Error("Incomplete book download");
    },
  }));
  return new Response(limited, { headers });
}

export async function handleZlibrary(request: Request, fetcher: Fetcher = fetch): Promise<Response> {
  if (request.method !== "POST") return json({ error: "只支持 POST 请求" }, 405);
  const origin = request.headers.get("origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") return json({ error: "不允许跨站请求" }, 403);
  if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "请求必须使用 JSON" }, 415);
  const action = new URL(request.url).pathname.replace("/api/zlibrary/", "");
  try {
    let payload: Json;
    try { payload = await readJson(new Response(request.body), 8192); } catch { throw new ServiceError("请求数据无效或过长", 400); }
    if (action === "session") return json({ connected: !!session(request) });
    if (action === "logout") return setSession(json({ connected: false }), request, null);
    if (action === "login") {
      const email = text(payload.email).trim(), password = text(payload.password);
      if (!email || !password || email.length > 254 || password.length > 1024) throw new ServiceError("请填写有效的邮箱和密码", 400);
      const form = new URLSearchParams({ email, password, site_mode: "books", action: "login", isModal: "true", gg_json_mode: "1", redirectUrl: `${ZLIBRARY_ORIGIN}/` });
      const data = await api("/rpc.php", request, fetcher, form);
      const user = object(data.response);
      const id = text(user.user_id), key = text(user.user_key);
      if (!/^\d{1,20}$/.test(id) || !/^[a-zA-Z0-9_-]{8,256}$/.test(key)) failUpstream(data, "登录未成功，请检查账号或稍后重试");
      return setSession(json({ connected: true }), request, { id, key });
    }
    if (action === "search") {
      const query = text(payload.query).trim(), page = Number(payload.page ?? 1), format = text(payload.format);
      if (!query || query.length > 200 || !Number.isInteger(page) || page < 1 || page > 500) throw new ServiceError("请输入书名或作者（最多 200 字）", 400);
      if (format && !(ONLINE_BOOK_FORMATS as readonly string[]).includes(format)) throw new ServiceError("不支持这个文件格式", 400);
      const form = new URLSearchParams({ message: query, page: String(page), limit: String(PAGE_SIZE) });
      (format ? [format] : ONLINE_BOOK_FORMATS).forEach((value, index) => form.append(`extensions[${index}]`, value));
      const data = await api("/eapi/book/search", request, fetcher, form, { timeoutMs: SEARCH_TIMEOUT_MS, retryTransient: true });
      const raw = Array.isArray(data.books) ? data.books : object(data.exactMatch).books;
      if (!Array.isArray(raw)) throw new ServiceError("Z-Library 搜索结果格式已变化，暂时无法读取");
      const books = raw.map(normalizeBook).filter((book): book is OnlineBook => !!book);
      if (raw.length && !books.length) throw new ServiceError("Z-Library 返回的书籍数据无法识别");
      books.sort((a, b) => Number(b.extension === "epub") - Number(a.extension === "epub"));
      const pagination = object(data.pagination);
      const total = Number(pagination.total_items);
      return json({ books, page, hasMore: Number.isFinite(total) ? page * PAGE_SIZE < total : raw.length >= PAGE_SIZE });
    }
    if (action === "download") return await download(request, payload, fetcher);
    return json({ error: "接口不存在" }, 404);
  } catch (error) {
    const status = error instanceof ServiceError ? error.status : 502;
    // 不记录请求体、Cookie、密码或带令牌的下载地址。
    console.warn("zlibrary_request_failed", { action, status });
    const response = json({ error: error instanceof ServiceError ? error.message : "找书服务暂时不可用，请稍后重试" }, status);
    return status === 401 && action !== "login" ? setSession(response, request, null) : response;
  }
}
