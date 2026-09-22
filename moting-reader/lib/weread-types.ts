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
export type WereadLaneKind = "recommend" | "similar";

export interface WereadLane {
  kind: WereadLaneKind;
  title: string;
  /** similar 专用：种子书的书名，用来写「因为你在读《XX》」。 */
  seedTitle?: string;
  subtitle: string;
  books: WereadBook[];
}

export interface WereadRank {
  category: string;
  books: WereadBook[];
  /** 排名是从多大的池子里挑出来的，界面上要如实说。 */
  poolSize: number;
}

/**
 * 榜单分类。微信读书没有分类浏览接口，这些词是拿去当搜索关键词用的——
 * 实测 scope=10 搜「科幻」「历史」这类词能翻出上千条，足够攒出一条榜。
 */
export const WEREAD_CATEGORIES = [
  "小说",
  "科幻",
  "悬疑",
  "历史",
  "传记",
  "心理学",
  "哲学",
  "经济",
  "社会",
  "成长",
] as const;

export type WereadCategory = (typeof WEREAD_CATEGORIES)[number];

const CATEGORY_KEY = "moting:store-category";

/**
 * 主页和书城看同一个分类的榜。
 *
 * 在书城里选过就一直跟着那个选择走；没选过的话按天轮换——固定钉死在「小说」
 * 会让主页那条榜天天长一个样，而榜本身 6 小时才换一次内容。
 */
export function preferredCategory(): string {
  try {
    const saved = window.localStorage.getItem(CATEGORY_KEY);
    if (saved && (WEREAD_CATEGORIES as readonly string[]).includes(saved)) return saved;
  } catch {
    // 隐私模式下读不到，落到按天轮换即可。
  }
  const day = Math.floor(Date.now() / 86_400_000);
  return WEREAD_CATEGORIES[day % WEREAD_CATEGORIES.length];
}

export function rememberCategory(category: string): void {
  try {
    window.localStorage.setItem(CATEGORY_KEY, category);
  } catch {
    // 记不住就下次再按天轮换，不值得为它报错。
  }
}
