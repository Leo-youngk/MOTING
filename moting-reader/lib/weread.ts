import type {
  WereadBook,
  WereadBookDetail,
  WereadFeed,
  WereadSearchResult,
} from "./weread-types";

export class WereadError extends Error {}

/**
 * 图床同一张封面有几档尺寸，靠文件名前缀区分：`s_` 是缩略图，`t6_`/`t7_`/`t9_` 是大图。
 * 实测同一张图 s_ 6.5KB、t6_ 45KB——书城一屏 20 张卡，选错档就是 900KB 对 130KB。
 */
const COVER_VARIANT = /\/t\d+_/;

/**
 * 封面必须经 Worker 转发：微信读书图床不给 CORS 头，直接取会把 canvas 污染掉。
 *
 * 默认要大图：书籍资料那条链路要把封面压到 440px 存进书库，拿缩略图会糊。
 * 列表里的小卡片显式传 "thumb"。
 */
export function wereadCoverUrl(
  coverUrl: string,
  size: "thumb" | "full" = "full"
): string {
  const target = size === "thumb" ? coverUrl.replace(COVER_VARIANT, "/s_") : coverUrl;
  return `/api/weread/cover?u=${encodeURIComponent(target)}`;
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { signal, cache: "no-store" });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new WereadError("网络不可用，请检查连接后重试");
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : `书城服务返回 ${response.status}`;
    throw new WereadError(message);
  }
  return data as T;
}

export function searchWeread(
  keyword: string,
  maxIdx = 0,
  count = 10,
  signal?: AbortSignal
): Promise<WereadSearchResult> {
  const params = new URLSearchParams({
    keyword,
    maxIdx: String(maxIdx),
    count: String(count),
  });
  return request<WereadSearchResult>(`/api/weread/search?${params}`, signal);
}

export function fetchWereadBook(
  bookId: string,
  signal?: AbortSignal
): Promise<WereadBookDetail> {
  return request<WereadBookDetail>(
    `/api/weread/book?bookId=${encodeURIComponent(bookId)}`,
    signal
  );
}

export function fetchWereadRecommend(
  maxIdx = 0,
  count = 12,
  signal?: AbortSignal
): Promise<WereadFeed> {
  const params = new URLSearchParams({ maxIdx: String(maxIdx), count: String(count) });
  return request<WereadFeed>(`/api/weread/recommend?${params}`, signal);
}

export function fetchWereadSimilar(
  bookId: string,
  maxIdx = 0,
  count = 8,
  sessionId = "",
  signal?: AbortSignal
): Promise<WereadFeed> {
  const params = new URLSearchParams({
    bookId,
    maxIdx: String(maxIdx),
    count: String(count),
  });
  if (sessionId) params.set("sessionId", sessionId);
  return request<WereadFeed>(`/api/weread/similar?${params}`, signal);
}

/**
 * 「高分好书」是本地合成的，不是微信读书的官方榜单。
 *
 * 规则写在这里而不是散在组件里：评分人数太少的推荐值不可信（几十个人打的 95%
 * 说明不了什么），先卡人数门槛，再按推荐值排序。一本都不够格就返回空，
 * 让调用方把这条流整个藏掉——宁可不显示，也不要凑一条名不副实的榜。
 */
export function buildTopRated(
  books: WereadBook[],
  minRatingCount: number,
  limit: number
): WereadBook[] {
  const seen = new Set<string>();
  return books
    .filter((book) => {
      if (book.rating === null) return false;
      if ((book.ratingCount ?? 0) < minRatingCount) return false;
      if (seen.has(book.bookId)) return false;
      seen.add(book.bookId);
      return true;
    })
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
    .slice(0, limit);
}
