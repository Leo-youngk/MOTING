// 微信读书官方 Agent API Gateway 的服务端转发。
// 密钥只留在 Worker 侧，客户端永远看不到；客户端也不直接碰上游，一律走这里。
import type {
  WereadBook,
  WereadBookDetail,
  WereadFeed,
  WereadSearchResult,
} from "../lib/weread-types.ts";

const GATEWAY = "https://i.weread.qq.com/api/agent/gateway";
/** 网关强制要求上报，缺了会被当成过期客户端。跟本机 skill 的版本保持一致。 */
const SKILL_VERSION = "1.0.5";
/** 封面只从微信读书自己的图床取，别让 u= 变成任意地址的转发口。 */
const COVER_HOSTS = new Set(["cdn.weread.qq.com"]);
const COVER_HOST_SUFFIX = ".image.myqcloud.com";

const MAX_KEYWORD_LENGTH = 100;
const MAX_BOOK_ID_LENGTH = 32;
const BOOK_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_GATEWAY_BYTES = 1024 * 1024;
const MAX_COVER_BYTES = 4 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 12_000;
const SEARCH_CACHE_SECONDS = 60 * 60 * 6;
const BOOK_CACHE_SECONDS = 60 * 60 * 24;
const FEED_CACHE_SECONDS = 60 * 30;
/** 某本书的相似推荐几乎不变，首次回源要 1.7 秒，缓存一天。「为你推荐」仍按上面的半小时刷新。 */
const SIMILAR_CACHE_SECONDS = 60 * 60 * 24;
const COVER_CACHE_SECONDS = 60 * 60 * 24 * 30;
/**
 * 推荐和相似推荐的回包不带评分，得按本补查。
 * 并发度直接等于总数：12 本一轮打完，只花一个往返。
 * 原来是 6，要跑两轮——实测「换一批」2.8s 里有一大半是白等的第二轮。
 */
const MAX_ENRICH = 12;
const ENRICH_CONCURRENCY = MAX_ENRICH;
/*
 * 这里曾经有个 /api/weread/rank：拿分类词连搜好几页攒池、筛评分、排推荐值。
 * 它退休了——一次榜单请求要扇出好几个上游搜索，分类一多就撞风控（吃过 403）。
 * 分类书目本来也不需要实时，现在由 scripts/fetch-catalog.mjs 事先抓成
 * public/catalog/*.json，前端直接读文件。榜在客户端按同一套规则排（lib/store-catalog.ts）。
 */

interface WereadEnv {
  WEREAD_API_KEY?: string;
}

class GatewayError extends Error {
  status: number;
  // 不能用参数属性简写：测试跑在 node --experimental-strip-types 下，它不支持这个语法。
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, maxLength: number): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw ? raw.slice(0, maxLength) : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function errorResponse(message: string, status: number): Response {
  return Response.json(
    { error: message },
    { status, headers: { "cache-control": "no-store" } }
  );
}

/** 封面直链强制 https，并限死在微信读书的两个图床上。 */
function coverLink(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.replace(/^http:/i, "https:"));
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const allowed =
    COVER_HOSTS.has(url.hostname) || url.hostname.endsWith(COVER_HOST_SUFFIX);
  return allowed ? url.toString() : null;
}

/**
 * 上游把书籍信息摊在好几种形状里：搜索是 books[].bookInfo，
 * 推荐是直接平铺，相似推荐是 books[].book.bookInfo。这里统一收成一种。
 */
function normalizeBook(value: unknown): WereadBook | null {
  const outer = record(value);
  if (!outer) return null;
  const info =
    record(outer.bookInfo) ??
    record(record(outer.book)?.bookInfo) ??
    outer;
  const bookId = text(info.bookId, MAX_BOOK_ID_LENGTH);
  const title = text(info.title, 300);
  if (!bookId || !title) return null;

  // 评分可能挂在 bookInfo 上，也可能挂在它外面那层（搜索结果就是后者）。
  const ratingHost = info.newRating !== undefined ? info : outer;
  const detail = record(ratingHost.newRatingDetail);
  return {
    bookId,
    title,
    author: text(info.author, 200) ?? "",
    translator: text(info.translator, 200),
    coverUrl: coverLink(info.cover),
    intro: text(info.intro, 4000),
    category: text(info.category, 100),
    rating: count(ratingHost.newRating),
    ratingCount: count(ratingHost.newRatingCount),
    ratingLabel: text(detail?.title, 40),
    readingCount: count(outer.readingCount ?? info.readingCount),
  };
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new GatewayError("微信读书返回了空数据");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new GatewayError("微信读书返回的数据过大");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new GatewayError("微信读书返回了无法读取的数据");
  }
}

async function gateway(
  apiName: string,
  params: Record<string, unknown>,
  env: WereadEnv,
  signal: AbortSignal,
  fetcher: typeof fetch
): Promise<Record<string, unknown>> {
  const apiKey = env.WEREAD_API_KEY?.trim();
  // 没配密钥就说没配，不要返回空列表假装「没有结果」。
  if (!apiKey) throw new GatewayError("服务器未配置微信读书密钥，书城暂不可用", 503);

  let upstream: Response;
  try {
    upstream = await fetcher(GATEWAY, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json; charset=utf-8",
        accept: "application/json",
      },
      // 业务参数必须和 api_name 平铺在同一层，包进 params 会被网关丢掉。
      body: JSON.stringify({ api_name: apiName, ...params, skill_version: SKILL_VERSION }),
      signal,
    });
  } catch {
    throw new GatewayError("暂时连接不上微信读书，请稍后重试");
  }
  if (upstream.status === 401 || upstream.status === 403) {
    throw new GatewayError("微信读书密钥无效或已过期，需要重新获取", 502);
  }
  if (upstream.status === 429) {
    throw new GatewayError("微信读书请求过于频繁，请稍后重试", 503);
  }
  if (!upstream.ok) {
    throw new GatewayError(`微信读书暂时不可用（${upstream.status}）`);
  }

  const data = record(await readJson(upstream, MAX_GATEWAY_BYTES));
  if (!data) throw new GatewayError("微信读书返回了无法读取的数据");
  const errcode = data.errcode;
  if (typeof errcode === "number" && errcode !== 0) {
    const detail = text(data.errmsg, 120);
    throw new GatewayError(`微信读书：${detail ?? `错误 ${errcode}`}`);
  }
  return data;
}

/**
 * 推荐与相似推荐的回包只有书名作者封面，没有评分——而评分正是这次要给的东西。
 * 按本补查 /book/info，限并发也限总数，别把一屏推荐放大成几十个子请求。
 */
async function enrichRatings(
  books: WereadBook[],
  env: WereadEnv,
  signal: AbortSignal,
  fetcher: typeof fetch
): Promise<WereadBook[]> {
  const targets = books.slice(0, MAX_ENRICH).filter((book) => book.rating === null);
  if (!targets.length) return books;

  const byId = new Map<string, WereadBook>();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(ENRICH_CONCURRENCY, targets.length) }, async () => {
    while (cursor < targets.length) {
      const book = targets[cursor++];
      try {
        const data = await gateway("/book/info", { bookId: book.bookId }, env, signal, fetcher);
        const detail = normalizeBook(data);
        if (detail) byId.set(book.bookId, detail);
      } catch {
        // 补不到评分就让这本书没有评分，不编一个数字出来。
      }
    }
  });
  await Promise.all(workers);

  return books.map((book) => {
    const extra = byId.get(book.bookId);
    return extra
      ? {
          ...book,
          rating: extra.rating,
          ratingCount: extra.ratingCount,
          ratingLabel: extra.ratingLabel,
          intro: book.intro ?? extra.intro,
          category: book.category ?? extra.category,
          readingCount: book.readingCount ?? extra.readingCount,
        }
      : book;
  });
}

async function cached(
  cache: Cache | null,
  ctx: ExecutionContext | undefined,
  key: Request,
  seconds: number,
  build: () => Promise<unknown>
): Promise<Response> {
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch {
      // Cache API 在本地预览下不可用时照常回源。
    }
  }
  const data = await build();
  const response = Response.json(data, {
    headers: {
      "cache-control": `public, max-age=${seconds}`,
      "x-content-type-options": "nosniff",
    },
  });
  if (cache && ctx) ctx.waitUntil(cache.put(key, response.clone()).catch(() => undefined));
  return response;
}

function parseIdx(value: string | null): number {
  const idx = Number(value ?? "0");
  return Number.isInteger(idx) && idx >= 0 && idx <= 2000 ? idx : 0;
}

function parseCount(value: string | null, fallback: number, max: number): number {
  const n = Number(value ?? String(fallback));
  return Number.isInteger(n) && n > 0 && n <= max ? n : fallback;
}

async function handleSearch(
  url: URL,
  env: WereadEnv,
  signal: AbortSignal,
  fetcher: typeof fetch,
  cache: Cache | null,
  ctx?: ExecutionContext
): Promise<Response> {
  const keyword = url.searchParams.get("keyword")?.trim() ?? "";
  if (!keyword || keyword.length > MAX_KEYWORD_LENGTH) return errorResponse("搜索词无效", 400);
  if (/[\u0000-\u001f\u007f]/.test(keyword)) return errorResponse("搜索词含有无效字符", 400);
  const maxIdx = parseIdx(url.searchParams.get("maxIdx"));
  const size = parseCount(url.searchParams.get("count"), 10, 20);

  const key = new Request(
    `${url.origin}/api/weread/search?${new URLSearchParams({ keyword, maxIdx: String(maxIdx), count: String(size) })}`
  );
  return cached(cache, ctx, key, SEARCH_CACHE_SECONDS, async () => {
    const data = await searchPage(keyword, maxIdx, size, env, signal, fetcher);
    return {
      books: data.books,
      hasMore: data.hasMore,
      nextIdx: maxIdx + data.books.length,
    } satisfies WereadSearchResult;
  });
}

/**
 * scope=10 的回包是**一本书一个分组**（20 个分组各 1 本，scopeCount 都是 1），
 * 不是「一个分组装 20 本」。只读 results[0] 会永远只拿到一本书——这里必须把所有
 * 分组摊平。scope=0 的回包才是按「电子书 / 作者 / 书单」分组的，首个分组常常是空的。
 */
function collectBooks(data: Record<string, unknown>): WereadBook[] {
  const groups = Array.isArray(data.results) ? data.results : [];
  const books: WereadBook[] = [];
  const seen = new Set<string>();
  for (const value of groups) {
    const group = record(value);
    const raw = Array.isArray(group?.books) ? group.books : [];
    for (const item of raw) {
      const book = normalizeBook(item);
      if (!book || seen.has(book.bookId)) continue;
      seen.add(book.bookId);
      books.push(book);
    }
  }
  return books;
}

async function searchPage(
  keyword: string,
  maxIdx: number,
  size: number,
  env: WereadEnv,
  signal: AbortSignal,
  fetcher: typeof fetch
): Promise<{ books: WereadBook[]; hasMore: boolean }> {
  const data = await gateway(
    "/store/search",
    { keyword, scope: 10, count: size, maxIdx },
    env,
    signal,
    fetcher
  );
  const books = collectBooks(data);
  return { books, hasMore: data.hasMore === 1 && books.length > 0 };
}

async function handleBook(
  url: URL,
  env: WereadEnv,
  signal: AbortSignal,
  fetcher: typeof fetch,
  cache: Cache | null,
  ctx?: ExecutionContext
): Promise<Response> {
  const bookId = url.searchParams.get("bookId") ?? "";
  if (!BOOK_ID_PATTERN.test(bookId)) return errorResponse("书籍编号无效", 400);

  const key = new Request(`${url.origin}/api/weread/book?bookId=${bookId}`);
  return cached(cache, ctx, key, BOOK_CACHE_SECONDS, async () => {
    const data = await gateway("/book/info", { bookId }, env, signal, fetcher);
    const book = normalizeBook(data);
    if (!book) throw new GatewayError("微信读书没有返回这本书的资料");
    const detail = record(data.newRatingDetail);
    return {
      ...book,
      ratingGood: count(detail?.good),
      ratingFair: count(detail?.fair),
      ratingPoor: count(detail?.poor),
    } satisfies WereadBookDetail;
  });
}

async function handleRecommend(
  url: URL,
  env: WereadEnv,
  signal: AbortSignal,
  fetcher: typeof fetch,
  cache: Cache | null,
  ctx?: ExecutionContext
): Promise<Response> {
  const maxIdx = parseIdx(url.searchParams.get("maxIdx"));
  const size = parseCount(url.searchParams.get("count"), 12, 20);
  const key = new Request(
    `${url.origin}/api/weread/recommend?${new URLSearchParams({ maxIdx: String(maxIdx), count: String(size) })}`
  );
  return cached(cache, ctx, key, FEED_CACHE_SECONDS, async () => {
    const data = await gateway("/book/recommend", { count: size, maxIdx }, env, signal, fetcher);
    const raw = Array.isArray(data.books) ? data.books : [];
    const books = await enrichRatings(
      raw.map(normalizeBook).filter((book): book is WereadBook => book !== null),
      env,
      signal,
      fetcher
    );
    return {
      books,
      nextIdx: maxIdx + books.length,
      hasMore: books.length >= size,
      sessionId: null,
    } satisfies WereadFeed;
  });
}

async function handleSimilar(
  url: URL,
  env: WereadEnv,
  signal: AbortSignal,
  fetcher: typeof fetch,
  cache: Cache | null,
  ctx?: ExecutionContext
): Promise<Response> {
  const bookId = url.searchParams.get("bookId") ?? "";
  if (!BOOK_ID_PATTERN.test(bookId)) return errorResponse("书籍编号无效", 400);
  const maxIdx = parseIdx(url.searchParams.get("maxIdx"));
  const size = parseCount(url.searchParams.get("count"), 8, 20);
  const sessionId = url.searchParams.get("sessionId")?.slice(0, 64) ?? "";

  const key = new Request(
    `${url.origin}/api/weread/similar?${new URLSearchParams({ bookId, maxIdx: String(maxIdx), count: String(size) })}`
  );
  return cached(cache, ctx, key, SIMILAR_CACHE_SECONDS, async () => {
    // maxIdx 和 sessionId 必须都带上，少一个网关就回「参数格式错误」——文档没写这条。
    const data = await gateway(
      "/book/similar",
      { bookId, count: size, maxIdx, sessionId },
      env,
      signal,
      fetcher
    );
    const wrapper = record(data.booksimilar);
    const raw = Array.isArray(wrapper?.books) ? wrapper.books : [];
    const books = await enrichRatings(
      raw.map(normalizeBook).filter((book): book is WereadBook => book !== null),
      env,
      signal,
      fetcher
    );
    return {
      books,
      nextIdx: maxIdx + books.length,
      hasMore: books.length >= size,
      sessionId: text(wrapper?.sessionId, 64),
    } satisfies WereadFeed;
  });
}

async function handleCover(
  request: Request,
  url: URL,
  fetcher: typeof fetch,
  cache: Cache | null,
  ctx?: ExecutionContext
): Promise<Response> {
  const raw = url.searchParams.get("u") ?? "";
  const target = coverLink(raw);
  if (!target) return errorResponse("封面地址不在允许的来源里", 400);

  const key = new Request(
    `${url.origin}/api/weread/cover?${new URLSearchParams({ u: target })}`
  );
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch {
      // 同上。
    }
  }

  let upstream: Response;
  try {
    upstream = await fetcher(target, {
      headers: { accept: "image/*", referer: "https://weread.qq.com/" },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
    });
  } catch {
    return errorResponse("暂时取不到封面", 502);
  }
  if (!upstream.ok) return errorResponse(`封面暂时不可用（${upstream.status}）`, 502);
  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("image/")) {
    return errorResponse("封面地址没有返回图片", 502);
  }
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > MAX_COVER_BYTES) {
    return errorResponse("封面文件过大或为空", 502);
  }
  const response = new Response(bytes, {
    headers: {
      "content-type": contentType,
      "cache-control": `public, max-age=${COVER_CACHE_SECONDS}`,
      "x-content-type-options": "nosniff",
    },
  });
  if (cache && ctx) ctx.waitUntil(cache.put(key, response.clone()).catch(() => undefined));
  return response;
}

export async function handleWeread(
  request: Request,
  env: WereadEnv,
  ctx?: ExecutionContext,
  fetcher: typeof fetch = fetch
): Promise<Response> {
  if (request.method !== "GET") return errorResponse("只支持 GET 请求", 405);
  const url = new URL(request.url);
  const cache = ctx && typeof caches !== "undefined" ? caches.default : null;
  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  ]);

  try {
    switch (url.pathname) {
      case "/api/weread/search":
        return await handleSearch(url, env, signal, fetcher, cache, ctx);
      case "/api/weread/book":
        return await handleBook(url, env, signal, fetcher, cache, ctx);
      case "/api/weread/recommend":
        return await handleRecommend(url, env, signal, fetcher, cache, ctx);
      case "/api/weread/similar":
        return await handleSimilar(url, env, signal, fetcher, cache, ctx);
      case "/api/weread/cover":
        return await handleCover(request, url, fetcher, cache, ctx);
      default:
        return errorResponse("接口不存在", 404);
    }
  } catch (error) {
    if (error instanceof GatewayError) return errorResponse(error.message, error.status);
    return errorResponse("书城暂时不可用，请稍后重试", 502);
  }
}
