import type {
  WereadBookDetail,
  WereadFeed,
  WereadRank,
  WereadSearchResult,
} from "./weread-types";

export class WereadError extends Error {}

/**
 * 图床同一张封面有整整一梯尺寸，靠文件名前缀区分（实测）：
 * s_ 70×101 · t1_ 84×121 · t4_ 174×251 · t6_ 250×361 · t7_ 285×412 · t9_ 428×619。
 *
 * 选档只看「渲染宽度 × 设备像素比」：104px 的卡片在 iPhone 3 倍屏上要 312px，
 * 拿 s_ 那档等于放大四倍半，糊得一眼能看出来——这个坑踩过一次。
 * 两个图床的任意两档都能互转，所以传进来是哪一档都不影响。
 */
const COVER_VARIANT = /\/(?:s|t\d+)_/;
const COVER_SIZES = {
  /** 行式列表的小封面：50 CSS px，3 倍屏要 150。 */
  row: "t4_",
  /** 横滑卡片：104 CSS px，3 倍屏要 312。 */
  card: "t7_",
  /** 详情页大图，以及要压进书库存起来的封面。 */
  large: "t9_",
} as const;

/**
 * 封面必须经 Worker 转发：微信读书图床不给 CORS 头，直接取会把 canvas 污染掉。
 * 默认取大图——书籍资料那条链路要把封面压到 440px 存进书库，拿小图会糊。
 */
export function wereadCoverUrl(
  coverUrl: string,
  size: keyof typeof COVER_SIZES = "large"
): string {
  const target = coverUrl.replace(COVER_VARIANT, `/${COVER_SIZES[size]}`);
  return `/api/weread/cover?u=${encodeURIComponent(target)}`;
}

export function fetchWereadRank(
  category: string,
  signal?: AbortSignal
): Promise<WereadRank> {
  return request<WereadRank>(
    `/api/weread/rank?category=${encodeURIComponent(category)}`,
    signal
  );
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
