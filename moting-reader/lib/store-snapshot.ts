import type { WereadBook } from "./weread-types";

/**
 * 书城条上一次的结果：「为你推荐」和主页那条榜的前三名。
 *
 * 主页每次挂载都现取、先出骨架，取回来的高度和骨架对不上，就把下面的内容往下推——
 * 每次打开、每次切回主页都要跳一下。现在直接画上一次的结果；后台取到的新推荐存起来留给下次打开，
 * 不在用户眼皮底下把已经看到的书换掉。
 */
export interface FeedSnapshot {
  books: WereadBook[];
  /** 「换一批」从哪儿接着取。 */
  nextIdx: number;
}

const FEED_KEY = "moting:store-feed";
const RANK_KEY = "moting:store-rank";

/** 这一次打开 App 里屏幕上正在用的那份；切 tab 回来还是它，不会换。 */
let sessionFeed: FeedSnapshot | null | undefined;

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存不了：下次打开照旧现取，只是会先出骨架。
  }
}

function validFeed(value: FeedSnapshot | null): FeedSnapshot | null {
  return value && Array.isArray(value.books) && value.books.length
    ? { books: value.books, nextIdx: Number(value.nextIdx) || 0 }
    : null;
}

export function readFeed(): FeedSnapshot | null {
  if (sessionFeed === undefined) sessionFeed = validFeed(readJson<FeedSnapshot>(FEED_KEY));
  return sessionFeed;
}

/** 屏幕上换成了这一批（首次取到、或者点了「换一批」）。 */
export function showFeed(snapshot: FeedSnapshot): void {
  sessionFeed = snapshot;
  writeJson(FEED_KEY, snapshot);
}

/** 后台取到的新推荐：只留给下次打开，这一次屏幕上的不动。 */
export function keepFeedForNextLaunch(snapshot: FeedSnapshot): void {
  writeJson(FEED_KEY, snapshot);
}

export function readRank(category: string): WereadBook[] | null {
  const stored = readJson<{ category: string; books: WereadBook[] }>(RANK_KEY);
  return stored?.category === category && Array.isArray(stored.books) && stored.books.length
    ? stored.books
    : null;
}

export function keepRank(category: string, books: WereadBook[]): void {
  writeJson(RANK_KEY, { category, books });
}
