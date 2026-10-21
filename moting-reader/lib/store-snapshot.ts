import type { BookMeta, ReadingSession } from "./types.ts";
import type { WereadBook } from "./weread-types.ts";
import { loadDiscoveryPool } from "./store-catalog.ts";
import {
  DAY_MS, discoveryDay, discoveryKey, feedbackFor, isOwnedBook, selectDiscoveryBoard,
  selectDiscoveryBooks, type DiscoveryBoard, type DiscoveryHistory,
} from "./store-discovery.ts";

const SNAPSHOT_KEY = "moting:store-discovery:v2";
const HISTORY_KEY = "moting:store-feedback:v1";
export const DISCOVERY_BATCH_SIZE = 20;
export interface FeedSnapshot { day: string; batch: number; books: WereadBook[] }
export interface DiscoveryState {
  feed: FeedSnapshot | null;
  board: DiscoveryBoard | null;
  loading: boolean;
  error: string;
  notice: string;
}
const EMPTY: DiscoveryState = { feed: null, board: null, loading: true, error: "", notice: "" };
let state = EMPTY;
let initialized = false;
let history: DiscoveryHistory | undefined;
let owned: readonly BookMeta[] = [];
let sessions: readonly ReadingSession[] = [];
let boardTurn = 0;
let pool: Awaited<ReturnType<typeof loadDiscoveryPool>> | null = null;
let loading: Promise<void> | null = null;
let storageWarning = false;
const listeners = new Set<() => void>();

function readJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeJson(key: string, value: unknown) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); }
  catch {
    if (!storageWarning) {
      storageWarning = true;
      console.warn("store_feedback_storage_unavailable", { mode: "memory" });
    }
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function readDiscoveryHistory(): DiscoveryHistory {
  if (history) return history;
  history = {};
  const stored = record(readJson(HISTORY_KEY));
  if (!stored) return history;
  const now = Date.now();
  for (const [key, raw] of Object.entries(stored).slice(-2000)) {
    const entry = record(raw);
    if (!entry || typeof entry.seenAt !== "number" || typeof entry.openedAt !== "number" ||
      !Number.isFinite(entry.seenAt) || !Number.isFinite(entry.openedAt) ||
      entry.seenAt < 0 || entry.openedAt < 0 || Math.max(entry.seenAt, entry.openedAt) > now + DAY_MS ||
      typeof entry.hidden !== "boolean") continue;
    if (!entry.hidden && Math.max(entry.seenAt, entry.openedAt) < now - 90 * DAY_MS) continue;
    history[key] = {
      seenAt: entry.seenAt, openedAt: entry.openedAt, hidden: entry.hidden,
      seenDay: typeof entry.seenDay === "string" ? entry.seenDay : "",
      impressions: typeof entry.impressions === "number" && Number.isFinite(entry.impressions)
        ? Math.max(0, Math.min(100, entry.impressions)) : 0,
      category: typeof entry.category === "string" ? entry.category.slice(0, 100) : null,
    };
  }
  return history;
}

function saveHistory() {
  history = Object.fromEntries(Object.entries(readDiscoveryHistory())
    .sort((a, b) => Number(b[1].hidden) - Number(a[1].hidden) ||
      Math.max(b[1].seenAt, b[1].openedAt) - Math.max(a[1].seenAt, a[1].openedAt)).slice(0, 2000));
  writeJson(HISTORY_KEY, history);
}

/** 只有实际可见的卡片调用；同一作品一天只记一次，切页不会重复扣权重。 */
export function recordBookExposure(book: WereadBook, now = Date.now()) {
  const entries = readDiscoveryHistory();
  const entry = feedbackFor(entries, book);
  const day = discoveryDay(now);
  if (entry.seenDay === day) return;
  entries[discoveryKey(book)] = { ...entry, seenAt: now, seenDay: day, impressions: entry.impressions + 1 };
  saveHistory();
}

export function recordBookOpen(book: WereadBook) {
  const entries = readDiscoveryHistory();
  entries[discoveryKey(book)] = { ...feedbackFor(entries, book), openedAt: Date.now() };
  saveHistory();
}

export function isDiscoveryHidden(book: WereadBook) {
  return Boolean(readDiscoveryHistory()[discoveryKey(book)]?.hidden);
}

export function setDiscoveryHidden(book: WereadBook, hidden: boolean) {
  const entries = readDiscoveryHistory();
  entries[discoveryKey(book)] = { ...feedbackFor(entries, book), hidden };
  saveHistory();
  if (hidden && state.feed) {
    publish({ ...state, feed: { ...state.feed, books: state.feed.books.filter((item) => discoveryKey(item) !== discoveryKey(book)) } });
  }
}

export function subscribeDiscovery(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function getDiscoveryState() { return state; }
export function getServerDiscoveryState() { return EMPTY; }

function publish(next: DiscoveryState) {
  state = next;
  if (state.feed) writeJson(SNAPSHOT_KEY, { feed: state.feed, board: state.board, boardTurn });
  for (const listener of listeners) listener();
}

function validBook(value: unknown): value is WereadBook {
  const book = record(value);
  return Boolean(book && typeof book.bookId === "string" && typeof book.title === "string" && typeof book.author === "string");
}

function restoreSnapshot() {
  const stored = record(readJson(SNAPSHOT_KEY));
  const feed = record(stored?.feed);
  if (!feed || feed.day !== discoveryDay() || !Array.isArray(feed.books) ||
    !feed.books.length || feed.books.length > DISCOVERY_BATCH_SIZE || !feed.books.every(validBook) ||
    typeof feed.batch !== "number" || !Number.isSafeInteger(feed.batch) || feed.batch < 0) return;
  const board = record(stored?.board);
  const validBoard = board && typeof board.category === "string" && typeof board.generatedAt === "string" &&
    ["quality", "popular", "hidden"].includes(String(board.kind)) && Array.isArray(board.entries) &&
    board.entries.length > 0 && board.entries.length <= 3 && board.entries.every((value: unknown) => {
      const entry = record(value);
      return entry && validBook(entry.book) && typeof entry.rank === "number" && Number.isInteger(entry.rank) && entry.rank > 0;
    });
  boardTurn = typeof stored?.boardTurn === "number" && Number.isSafeInteger(stored.boardTurn) && stored.boardTurn >= 0
    ? stored.boardTurn : 0;
  state = {
    ...EMPTY, feed: feed as unknown as FeedSnapshot,
    board: validBoard ? board as unknown as DiscoveryBoard : null, loading: false,
  };
}

function makeFeed(previous: FeedSnapshot | null, freshDay = false): FeedSnapshot {
  const day = discoveryDay();
  const batch = freshDay || !previous ? 0 : previous.batch + 1;
  return {
    day, batch,
    books: selectDiscoveryBooks(pool!.books, {
      owned, sessions, history: readDiscoveryHistory(), seed: `${day}:${batch}`,
      limit: DISCOVERY_BATCH_SIZE, exclude: previous?.books,
    }),
  };
}

/** 首页与书城共用一个状态；同一天切页、重载都保留当前批次。 */
export async function startDiscovery(books: readonly BookMeta[], readingSessions: readonly ReadingSession[] = []) {
  owned = books.filter((book) => book.format !== "demo");
  sessions = readingSessions;
  if (!initialized) {
    initialized = true;
    restoreSnapshot();
    if (state.feed) state = { ...state, feed: { ...state.feed, books: state.feed.books.filter((book) => !isOwnedBook(book, owned) && !isDiscoveryHidden(book)) } };
    publish(state);
  } else if (state.feed?.books.some((book) => isOwnedBook(book, owned))) {
    publish({ ...state, feed: { ...state.feed, books: state.feed.books.filter((book) => !isOwnedBook(book, owned)) } });
  }
  if (loading) return loading;
  loading = (async () => {
    try {
      pool ??= await loadDiscoveryPool();
      const newDay = state.feed?.day !== discoveryDay();
      const feed = newDay || !state.feed?.books.length ? makeFeed(state.feed, newDay) : state.feed;
      if (newDay) boardTurn = 0;
      const board = !newDay && state.board ? state.board : selectDiscoveryBoard(pool.catalogs, feed.day, boardTurn);
      publish({
        feed, board, loading: false, error: "",
        notice: pool.unavailable ? "部分分类暂时读不到，先从已加载书目中挑选" : "",
      });
    } catch (error) {
      publish({ ...state, loading: false, error: error instanceof Error ? error.message : "推荐暂时读不到，稍后重试" });
    }
  })().finally(() => { loading = null; });
  return loading;
}

export function shuffleDiscovery() {
  if (!pool) { void startDiscovery(owned, sessions); return; }
  const feed = makeFeed(state.feed);
  if (!feed.books.length) {
    publish({ ...state, notice: "暂时没有更多未入库、未屏蔽的书，可以换个分类逛逛" });
    return;
  }
  publish({ ...state, feed, notice: pool.unavailable ? "部分分类暂时读不到，当前使用已加载书目" : "" });
}

export function shuffleDiscoveryBoard() {
  if (!pool) return;
  boardTurn += 1;
  publish({ ...state, board: selectDiscoveryBoard(pool.catalogs, discoveryDay(), boardTurn) });
}
