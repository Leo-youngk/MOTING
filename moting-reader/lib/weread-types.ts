/** 书城与书籍资料的唯一数据源。取代了早先的 Open Library 与 Google Books。 */
export const WEREAD_SOURCE = "weread";

/**
 * 推荐值是千分制：930 表示 93.0%。
 * 接口文档写的是「0-100」，实测是 0-1000，以实测为准。
 */
export function ratingPercent(rating: number | null): string | null {
  return rating === null ? null : `${(rating / 10).toFixed(1)}%`;
}

/** 评分人数到了这个量级，推荐值才有参考意义；低于它只显示人数不显示百分比。 */
export const RATING_TRUSTWORTHY_COUNT = 500;

export function formatRatingCount(count: number | null): string | null {
  if (count === null || count <= 0) return null;
  if (count < 10000) return `${count} 人`;
  return `${(count / 10000).toFixed(1)} 万人`;
}

export function formatReadingCount(count: number | null): string | null {
  if (count === null || count <= 0) return null;
  if (count < 10000) return `${count} 人在读`;
  return `${(count / 10000).toFixed(1)} 万人在读`;
}

export interface WereadBook {
  bookId: string;
  title: string;
  author: string;
  translator: string | null;
  coverUrl: string | null;
  intro: string | null;
  category: string | null;
  /** 千分制推荐值，拿不到就是 null——不要拿 0 顶替，0 和「没有评分」是两回事。 */
  rating: number | null;
  ratingCount: number | null;
  /** 微信读书自己的档位标签：神作 / 好评如潮 / 口碑不错。 */
  ratingLabel: string | null;
  readingCount: number | null;
}

/** 书籍详情比列表多出评分分布，用来画好评/一般/差评那三段。 */
export interface WereadBookDetail extends WereadBook {
  ratingGood: number | null;
  ratingFair: number | null;
  ratingPoor: number | null;
}

export interface WereadSearchResult {
  books: WereadBook[];
  total: number;
  hasMore: boolean;
  nextIdx: number;
}

export interface WereadFeed {
  books: WereadBook[];
  nextIdx: number;
  hasMore: boolean;
  /** /book/similar 翻页要把它带回去。 */
  sessionId: string | null;
}

/** 书城里的一条流。 */
export type WereadLaneKind = "recommend" | "similar" | "top-rated";

export interface WereadLane {
  kind: WereadLaneKind;
  title: string;
  /** similar 专用：种子书的书名，用来写「因为你在读《XX》」。 */
  seedTitle?: string;
  subtitle: string;
  books: WereadBook[];
}
