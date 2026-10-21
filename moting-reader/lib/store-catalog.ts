import { CATEGORY_SLUGS, WEREAD_CATEGORIES, type WereadBook } from "./weread-types.ts";

/**
 * 书城的分类书目。
 *
 * 这些书目不是现查的，是 scripts/fetch-catalog.mjs 事先抓好、跟着应用一起发的静态 JSON。
 * 原因见那个脚本的注释：榜单现查会把一次请求扇成好几个上游搜索，量一上来就撞风控。
 * 书目本身是慢变量，抓一次能用很久；要更新就重跑脚本、重新部署。
 */
export interface StoreCatalog {
  category: string;
  /** 抓取日期（YYYY-MM-DD）。界面上要如实标出来，不要让人以为是实时的。 */
  generatedAt: string;
  books: WereadBook[];
}

/** 评分人数到这个量级，推荐值才值得拿来排序。跟 weread-types 里那个门槛是同一个。 */
const RANKABLE_MIN_COUNT = 500;

const loaded = new Map<string, Promise<StoreCatalog>>();
/** 已经取到手的书目。进书城时有现成的就直接画，不必先出一帧骨架再等 Promise 回来。 */
const settled = new Map<string, StoreCatalog>();

export class CatalogError extends Error {}

/**
 * 读一个分类的书目。同一个分类只会真的取一次，之后走内存。
 * 文件本身还有 HTTP 缓存和 Service Worker 兜着（/catalog/ 走 network-first）。
 */
export function loadCatalog(category: string): Promise<StoreCatalog> {
  const slug = CATEGORY_SLUGS[category];
  if (!slug) return Promise.reject(new CatalogError(`没有「${category}」这个分类`));

  const hit = loaded.get(slug);
  if (hit) return hit;

  const task = fetch(`/catalog/${slug}.json`)
    .then(async (response) => {
      if (!response.ok) throw new CatalogError(`书目文件读不到（${response.status}）`);
      const data = (await response.json()) as StoreCatalog;
      if (!Array.isArray(data?.books)) throw new CatalogError("书目文件格式不对");
      const catalog: StoreCatalog = {
        category: data.category ?? category,
        generatedAt: data.generatedAt ?? "",
        // 简介没存进文件——列表用不上，详情页会去查 /book/info。
        books: data.books.map((book) => ({ ...book, intro: book.intro ?? null })),
      };
      settled.set(slug, catalog);
      return catalog;
    })
    .catch((error: unknown) => {
      // 失败不留在缓存里，下次进来还能再试一次。
      loaded.delete(slug);
      throw error instanceof CatalogError
        ? error
        : new CatalogError("书目暂时读不到，检查下网络");
    });

  loaded.set(slug, task);
  return task;
}

/** 这一次打开 App 里已经取到的书目；没取过就是 null。 */
export function peekCatalog(category: string): StoreCatalog | null {
  const slug = CATEGORY_SLUGS[category];
  return (slug && settled.get(slug)) || null;
}

/**
 * 从书目里排一条榜：评分人数够多的，按推荐值从高到低。
 *
 * 门槛不能降——三十个人打出的 96% 说明不了任何事，
 * 让这种书占住榜首，整条榜就没人信了。宁可榜短一点。
 */
export const RANKING_KINDS = ["quality", "popular", "hidden"] as const;
export type RankingKind = (typeof RANKING_KINDS)[number];
export const RANKING_LABELS: Record<RankingKind, string> = {
  quality: "口碑榜",
  popular: "热读榜",
  hidden: "小众口碑",
};
export const RANKING_NOTES: Record<RankingKind, string> = {
  quality: "至少 500 人评价，按推荐值排序",
  popular: "按书目快照中的在读人数排序",
  hidden: "500～1 万人评价、推荐值至少 85%，按推荐值排序",
};

export function preferredRanking(): RankingKind {
  try {
    const saved = window.localStorage.getItem("moting:store-ranking");
    if (RANKING_KINDS.includes(saved as RankingKind)) return saved as RankingKind;
  } catch { /* 隐私模式仍可使用默认口碑榜。 */ }
  return "quality";
}

export function rememberRanking(kind: RankingKind) {
  try { window.localStorage.setItem("moting:store-ranking", kind); }
  catch { /* 当前页面仍然保留选择。 */ }
}

export function rankOf(books: WereadBook[], limit: number, kind: RankingKind = "quality"): WereadBook[] {
  return books
    .filter((book) => kind === "popular"
      ? (book.readingCount ?? 0) > 0
      : book.rating !== null && (book.ratingCount ?? 0) >= RANKABLE_MIN_COUNT &&
        (kind !== "hidden" || (book.rating! >= 850 && book.ratingCount! < 10_000)))
    .sort((a, b) => (kind === "popular"
      ? (b.readingCount ?? 0) - (a.readingCount ?? 0)
      : (b.rating ?? 0) - (a.rating ?? 0)) ||
      (b.ratingCount ?? 0) - (a.ratingCount ?? 0) || a.bookId.localeCompare(b.bookId))
    .slice(0, limit);
}

let poolTask: Promise<{ catalogs: StoreCatalog[]; books: WereadBook[]; unavailable: number }> | null = null;

/** 仅加载现有静态书目，最多三路并行；换批不会放大上游请求。 */
export function loadDiscoveryPool() {
  if (poolTask) return poolTask;
  poolTask = (async () => {
    const catalogs: StoreCatalog[] = [];
    let unavailable = 0;
    for (let i = 0; i < WEREAD_CATEGORIES.length; i += 3) {
      const results = await Promise.allSettled(WEREAD_CATEGORIES.slice(i, i + 3).map(loadCatalog));
      for (const result of results) {
        if (result.status === "fulfilled") catalogs.push(result.value);
        else unavailable += 1;
      }
    }
    if (!catalogs.length) throw new CatalogError("书目暂时读不到，检查网络后重试");
    return {
      catalogs,
      books: catalogs.flatMap((catalog) => catalog.books.map((book) => ({
        ...book, category: book.category ?? catalog.category,
      }))),
      unavailable,
    };
  })().catch((error: unknown) => {
    poolTask = null;
    throw error;
  });
  return poolTask;
}
