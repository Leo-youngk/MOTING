import { DISCOVERY_TOPICS, type DiscoveryBook, type DiscoveryDetail, type DiscoveryLanguage, type DiscoveryPage } from "../lib/discovery-types.ts";

const OPEN_LIBRARY_ORIGIN = "https://openlibrary.org";
const PAGE_SIZE = 20;
const MAX_SEARCH_BYTES = 1024 * 1024;
const MAX_WORK_BYTES = 256 * 1024;
const UPSTREAM_TIMEOUT_MS = 12000;
const CACHE_SECONDS = 60 * 30;
const WORK_ID_PATTERN = /^OL\d+W$/;
const APP_USER_AGENT = "MotingReader/0.1 (+https://github.com/Leo-youngk/MOTING)";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function string(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= maxLength ? value.trim() : null;
}

function coverId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function workId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.replace(/^\/works\//, "");
  return WORK_ID_PATTERN.test(id) ? id : null;
}

function normalizeBook(value: unknown): DiscoveryBook | null {
  const doc = record(value);
  if (!doc) return null;
  const id = workId(doc.key);
  const editions = record(doc.editions)?.docs;
  const edition = Array.isArray(editions) ? record(editions[0]) : null;
  const title = string(edition?.title, 300) ?? string(doc.title, 300);
  if (!id || !title) return null;
  const authors = Array.isArray(doc.author_name)
    ? doc.author_name.map((name) => string(name, 120)).filter((name): name is string => Boolean(name)).slice(0, 3)
    : [];
  const year = typeof doc.first_publish_year === "number" && Number.isInteger(doc.first_publish_year)
    && doc.first_publish_year > 0 && doc.first_publish_year <= new Date().getUTCFullYear() + 1
    ? doc.first_publish_year
    : null;
  const imageId = coverId(edition?.cover_i) ?? coverId(doc.cover_i);
  return {
    workId: id,
    title,
    author: authors.join(" · "),
    year,
    coverUrl: imageId ? `https://covers.openlibrary.org/b/id/${imageId}-M.jpg` : null,
    sourceUrl: `${OPEN_LIBRARY_ORIGIN}/works/${id}`,
  };
}

function normalizePage(value: unknown, page: number): DiscoveryPage {
  const data = record(value);
  if (!data || !Array.isArray(data.docs)) throw new Error("书目数据格式已变化，请稍后重试");
  const books = data.docs.map(normalizeBook).filter((book): book is DiscoveryBook => book !== null);
  if (data.docs.length && !books.length) throw new Error("书目数据格式已变化，请稍后重试");
  const rawTotal = data.numFound ?? data.num_found;
  const total = typeof rawTotal === "number" && Number.isFinite(rawTotal) && rawTotal >= 0 ? rawTotal : null;
  return {
    books,
    page,
    hasMore: total !== null ? page * PAGE_SIZE < total : data.docs.length === PAGE_SIZE,
  };
}

function normalizeDetail(value: unknown): DiscoveryDetail {
  const data = record(value);
  if (!data || !workId(data.key)) throw new Error("书籍详情格式已变化，请稍后重试");
  const rawDescription = record(data.description)?.value ?? data.description;
  const description = typeof rawDescription === "string" && rawDescription.trim()
    ? rawDescription.trim().slice(0, 6000)
    : null;
  const subjects = Array.isArray(data.subjects)
    ? data.subjects.map((subject) => string(subject, 100)).filter((subject): subject is string => Boolean(subject)).slice(0, 5)
    : [];
  return { description, subjects };
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("json")) {
    throw new Error("书目服务没有返回 JSON 数据");
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error("书目数据过大");
  if (!response.body) throw new Error("书目服务返回了空数据");
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
        throw new Error("书目数据过大");
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
    throw new Error("书目服务返回了无法读取的数据");
  }
}

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
}

export async function handleDiscovery(
  request: Request,
  ctx?: ExecutionContext,
  fetcher: typeof fetch = fetch
): Promise<Response> {
  if (request.method !== "GET") return errorResponse("只支持 GET 请求", 405);
  const url = new URL(request.url);
  let upstreamUrl: URL;
  let cachePath: string;
  let maxBytes: number;
  let normalize: (value: unknown) => DiscoveryPage | DiscoveryDetail;

  if (url.pathname === "/api/discovery/search") {
    const topic = url.searchParams.get("topic");
    const query = url.searchParams.get("query")?.trim() ?? "";
    const hasTopic = topic !== null;
    if (hasTopic === Boolean(query) || (hasTopic && !DISCOVERY_TOPICS.some((item) => item.id === topic))) {
      return errorResponse("书籍分类或搜索词无效", 400);
    }
    if (query.length > 100 || /[\u0000-\u001f]/.test(query)) return errorResponse("搜索词过长或含有无效字符", 400);
    const language = url.searchParams.get("language") ?? "all";
    if (language !== "all" && language !== "zh" && language !== "en") return errorResponse("语言选项无效", 400);
    const page = Number(url.searchParams.get("page") ?? "1");
    if (!Number.isInteger(page) || page < 1 || page > 50) return errorResponse("页码无效", 400);
    const languageCode = (language as DiscoveryLanguage) === "zh" ? "chi" : language === "en" ? "eng" : null;
    const languageFilter = languageCode ? ` language:${languageCode}` : "";
    upstreamUrl = new URL("/search.json", OPEN_LIBRARY_ORIGIN);
    upstreamUrl.searchParams.set("q", `${hasTopic ? `subject_key:${topic}` : query}${languageFilter}`);
    upstreamUrl.searchParams.set("fields", "key,title,author_name,first_publish_year,cover_i,editions,editions.title,editions.cover_i");
    upstreamUrl.searchParams.set("limit", String(PAGE_SIZE));
    upstreamUrl.searchParams.set("page", String(page));
    upstreamUrl.searchParams.set("lang", language === "en" ? "en" : "zh");
    cachePath = `/api/discovery/search?${new URLSearchParams({
      ...(hasTopic ? { topic: topic! } : { query }), language, page: String(page),
    })}`;
    maxBytes = MAX_SEARCH_BYTES;
    normalize = (data) => normalizePage(data, page);
  } else if (url.pathname === "/api/discovery/work") {
    const id = url.searchParams.get("id");
    if (!id || !WORK_ID_PATTERN.test(id)) return errorResponse("书籍编号无效", 400);
    upstreamUrl = new URL(`/works/${id}.json`, OPEN_LIBRARY_ORIGIN);
    cachePath = `/api/discovery/work?id=${id}`;
    maxBytes = MAX_WORK_BYTES;
    normalize = normalizeDetail;
  } else {
    return errorResponse("接口不存在", 404);
  }

  const cache = ctx && typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(`${url.origin}${cachePath}`);
  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    } catch {
      // Cache API 在本地预览或某些区域不可用时，仍可继续获取书目。
    }
  }

  let upstream: Response;
  try {
    upstream = await fetcher(upstreamUrl.toString(), {
      headers: { accept: "application/json", "user-agent": APP_USER_AGENT },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
    });
  } catch {
    return errorResponse("暂时连接不上 Open Library，请稍后重试", 502);
  }
  if (upstream.status === 429) return errorResponse("Open Library 请求较多，请稍后重试", 503);
  if (!upstream.ok) return errorResponse(`Open Library 暂时不可用（${upstream.status}）`, 502);

  try {
    const result = normalize(await readJson(upstream, maxBytes));
    const response = Response.json(result, {
      headers: {
        "cache-control": `public, max-age=${CACHE_SECONDS}`,
        "x-content-type-options": "nosniff",
      },
    });
    if (cache && ctx) ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => undefined));
    return response;
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "书目数据读取失败", 502);
  }
}
