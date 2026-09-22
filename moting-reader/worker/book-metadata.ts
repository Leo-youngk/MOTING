import type {
  BookMetadataCandidate,
  BookMetadataLookup,
} from "../lib/book-metadata-types.ts";

const GOOGLE_BOOKS_ENDPOINT = "https://www.googleapis.com/books/v1/volumes";
/** 封面只从 Google 自己的图床取，别让 u= 变成一个任意地址的转发口。 */
const COVER_HOSTS = new Set([
  "books.google.com",
  "books.googleusercontent.com",
  "books.google.cn",
  "lh3.googleusercontent.com",
]);
const COVER_PREFERENCE = [
  "extraLarge",
  "large",
  "medium",
  "small",
  "thumbnail",
  "smallThumbnail",
] as const;

const MAX_RESULTS = 5;
const MAX_TITLE_LENGTH = 200;
const MAX_AUTHOR_LENGTH = 120;
const MAX_LOOKUP_BYTES = 512 * 1024;
const MAX_COVER_BYTES = 4 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 12_000;
const LOOKUP_CACHE_SECONDS = 60 * 60 * 24 * 7;
const COVER_CACHE_SECONDS = 60 * 60 * 24 * 30;

interface MetadataEnv {
  GOOGLE_BOOKS_API_KEY?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown, maxLength: number): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, maxLength) : null;
}

function errorResponse(message: string, status: number): Response {
  return Response.json(
    { error: message },
    { status, headers: { "cache-control": "no-store" } }
  );
}

function coverLink(imageLinks: Record<string, unknown> | null): string | null {
  if (!imageLinks) return null;
  for (const key of COVER_PREFERENCE) {
    const value = imageLinks[key];
    if (typeof value !== "string" || !value) continue;
    let url: URL;
    try {
      url = new URL(value.replace(/^http:/i, "https:"));
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || !COVER_HOSTS.has(url.hostname)) continue;
    // edge=curl 会画一道假的卷角阴影，缩到书库尺寸后就是封面边上一块脏东西。
    url.searchParams.delete("edge");
    return url.toString();
  }
  return null;
}

function normalizeCandidate(value: unknown): BookMetadataCandidate | null {
  const item = record(value);
  const info = record(item?.volumeInfo);
  const volumeId = string(item?.id, 64);
  const title = string(info?.title, 300);
  if (!volumeId || !info || !title) return null;

  const subtitle = string(info.subtitle, 200);
  const authors = Array.isArray(info.authors)
    ? info.authors
        .map((name) => string(name, 120))
        .filter((name): name is string => Boolean(name))
        .slice(0, 5)
    : [];
  const categories = Array.isArray(info.categories)
    ? info.categories
        .map((category) => string(category, 100))
        .filter((category): category is string => Boolean(category))
        .slice(0, 5)
    : [];

  return {
    volumeId,
    title: subtitle ? `${title}：${subtitle}` : title,
    authors,
    publishedDate: string(info.publishedDate, 20),
    description: string(info.description, 4000),
    categories,
    coverUrl: coverLink(record(info.imageLinks)),
    language: string(info.language, 16),
    infoLink: string(info.infoLink, 500),
  };
}

function normalizeLookup(value: unknown): BookMetadataLookup {
  const data = record(value);
  if (!data) throw new Error("书籍资料服务返回了无法读取的数据");
  const items = Array.isArray(data.items) ? data.items : [];
  return {
    candidates: items
      .map(normalizeCandidate)
      .filter((item): item is BookMetadataCandidate => item !== null)
      .slice(0, MAX_RESULTS),
  };
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new Error("书籍资料服务返回了空数据");
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
        throw new Error("书籍资料过大");
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
    throw new Error("书籍资料服务返回了无法读取的数据");
  }
}

/**
 * 查询词必须走 intitle:/inauthor: 字段算子。
 *
 * 实测：纯关键词 `q=三体` 返回的是一本三体科普漫画和一本英文数学书，刘慈欣的《三体》
 * 根本不在结果里；`q=百年孤独` 返回三本无关学术书。换成 intitle: 之后全部命中。
 * 中文语料的相关性排序指望不上，只能靠字段限定。
 */
function buildQuery(title: string, author: string): string {
  const quote = (value: string) => `"${value.replace(/"/g, " ").trim()}"`;
  const parts = [`intitle:${quote(title)}`];
  if (author) parts.push(`inauthor:${quote(author)}`);
  return parts.join(" ");
}

async function handleLookup(
  request: Request,
  url: URL,
  env: MetadataEnv,
  ctx: ExecutionContext | undefined,
  fetcher: typeof fetch
): Promise<Response> {
  const title = url.searchParams.get("title")?.trim() ?? "";
  const author = url.searchParams.get("author")?.trim() ?? "";
  if (!title || title.length > MAX_TITLE_LENGTH) return errorResponse("书名无效", 400);
  if (author.length > MAX_AUTHOR_LENGTH) return errorResponse("作者名过长", 400);
  if (/[\u0000-\u001f\u007f]/.test(title + author)) return errorResponse("书名或作者含有无效字符", 400);

  // trim 不能省：secret 很容易在写入时被管道带上尾随换行，Google 会直接判成无效密钥。
  const apiKey = env.GOOGLE_BOOKS_API_KEY?.trim();
  if (!apiKey) {
    // 没配密钥就老实说没配，不要返回空列表假装「这本书查不到」。
    return errorResponse("服务器未配置 Google Books 密钥，书籍资料补全暂不可用", 503);
  }

  const query = buildQuery(title, author);
  const cache = ctx && typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(
    `${url.origin}/api/metadata/lookup?${new URLSearchParams({ q: query })}`
  );
  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    } catch {
      // Cache API 在本地预览下不可用时照常回源。
    }
  }

  const upstreamUrl = new URL(GOOGLE_BOOKS_ENDPOINT);
  upstreamUrl.searchParams.set("q", query);
  upstreamUrl.searchParams.set("maxResults", String(MAX_RESULTS));
  upstreamUrl.searchParams.set("printType", "books");
  upstreamUrl.searchParams.set("orderBy", "relevance");
  // Workers 的出口 IP 落在哪个国家不固定，不显式带 country 会间歇性返回
  // 「unable to determine user location」。固定 US 让结果可复现。
  upstreamUrl.searchParams.set("country", "US");
  upstreamUrl.searchParams.set("key", apiKey);

  let upstream: Response;
  try {
    upstream = await fetcher(upstreamUrl.toString(), {
      headers: { accept: "application/json" },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
    });
  } catch {
    return errorResponse("暂时连接不上 Google Books，请稍后重试", 502);
  }
  if (upstream.status === 429) return errorResponse("Google Books 请求过于频繁，请稍后重试", 503);
  if (!upstream.ok) {
    // 上游的原因带上：4xx 基本都是密钥限制或参数问题，只报一个状态码没法排查。
    const detail = await upstream
      .text()
      .then((body) => {
        const parsed: unknown = JSON.parse(body);
        const error = record(record(parsed)?.error);
        return string(error?.message, 200);
      })
      .catch(() => null);
    if (upstream.status === 403) {
      return errorResponse(
        `Google Books 拒绝了请求，请检查密钥配额与限制${detail ? `：${detail}` : ""}`,
        502
      );
    }
    return errorResponse(
      `Google Books 暂时不可用（${upstream.status}${detail ? ` ${detail}` : ""}）`,
      502
    );
  }

  try {
    const result = normalizeLookup(await readJson(upstream, MAX_LOOKUP_BYTES));
    const response = Response.json(result, {
      headers: {
        "cache-control": `public, max-age=${LOOKUP_CACHE_SECONDS}`,
        "x-content-type-options": "nosniff",
      },
    });
    if (cache && ctx) ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => undefined));
    return response;
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "书籍资料读取失败", 502);
  }
}

async function handleCover(
  request: Request,
  url: URL,
  ctx: ExecutionContext | undefined,
  fetcher: typeof fetch
): Promise<Response> {
  const raw = url.searchParams.get("u") ?? "";
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return errorResponse("封面地址无效", 400);
  }
  if (target.protocol !== "https:" || !COVER_HOSTS.has(target.hostname)) {
    return errorResponse("封面地址不在允许的来源里", 400);
  }

  const cache = ctx && typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(
    `${url.origin}/api/metadata/cover?${new URLSearchParams({ u: target.toString() })}`
  );
  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    } catch {
      // 同上，缓存不可用不影响取图。
    }
  }

  let upstream: Response;
  try {
    upstream = await fetcher(target.toString(), {
      headers: { accept: "image/*" },
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
  const declared = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_COVER_BYTES) {
    return errorResponse("封面文件过大", 502);
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
  if (cache && ctx) ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => undefined));
  return response;
}

export async function handleBookMetadata(
  request: Request,
  env: MetadataEnv,
  ctx?: ExecutionContext,
  fetcher: typeof fetch = fetch
): Promise<Response> {
  if (request.method !== "GET") return errorResponse("只支持 GET 请求", 405);
  const url = new URL(request.url);
  if (url.pathname === "/api/metadata/lookup") {
    return handleLookup(request, url, env, ctx, fetcher);
  }
  if (url.pathname === "/api/metadata/cover") {
    return handleCover(request, url, ctx, fetcher);
  }
  return errorResponse("接口不存在", 404);
}
