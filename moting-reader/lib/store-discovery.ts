import { displayTitle } from "./display-title.ts";
import { rankOf, RANKING_KINDS, type RankingKind, type StoreCatalog } from "./store-catalog.ts";
import type { BookMeta, ReadingSession } from "./types.ts";
import type { WereadBook } from "./weread-types.ts";

export const DAY_MS = 86_400_000;
export const EXPOSURE_COOLDOWN_MS = 7 * DAY_MS;
export interface BookFeedback {
  seenAt: number;
  seenDay: string;
  impressions: number;
  openedAt: number;
  hidden: boolean;
  category: string | null;
}
export type DiscoveryHistory = Record<string, BookFeedback>;
type NamedBook = Pick<WereadBook, "title" | "author">;

export function discoveryDay(now = Date.now()): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function normalizedTitle(book: NamedBook): string {
  return displayTitle(book.title).normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\s_]+/gu, "");
}

function normalizedAuthor(book: NamedBook): string {
  return book.author.normalize("NFKC").replace(/\[[^\]]*\]|【[^】]*】/g, "")
    .toLowerCase().replace(/[\p{P}\p{Z}\s_]+/gu, "");
}

/** 同一作品的营销后缀和不同版本不重复推荐；不修改原始书名。 */
export function discoveryKey(book: NamedBook): string {
  return `${normalizedTitle(book)}|${normalizedAuthor(book)}`;
}

export function isOwnedBook(book: NamedBook, owned: readonly NamedBook[]): boolean {
  const title = normalizedTitle(book);
  const author = normalizedAuthor(book);
  return owned.some((item) => normalizedTitle(item) === title &&
    (!author || !normalizedAuthor(item) || normalizedAuthor(item) === author));
}

export function discoveryHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return hash >>> 0;
}

export function feedbackFor(history: DiscoveryHistory, book: WereadBook): BookFeedback {
  return history[discoveryKey(book)] ?? {
    seenAt: 0, seenDay: "", impressions: 0, openedAt: 0, hidden: false, category: book.category,
  };
}

function categoryOf(book: Pick<WereadBook, "category">): string {
  return book.category?.split("-")[0] ?? "其他";
}

function interleaveCategories(books: WereadBook[]): WereadBook[] {
  const pending = [...books];
  const ordered: WereadBook[] = [];
  while (pending.length) {
    const previous = ordered.at(-1);
    const index = previous ? pending.findIndex((book) => categoryOf(book) !== categoryOf(previous)) : 0;
    ordered.push(pending.splice(Math.max(0, index), 1)[0]);
  }
  return ordered;
}

export function selectDiscoveryBooks(pool: readonly WereadBook[], options: {
  owned: readonly BookMeta[];
  sessions?: readonly ReadingSession[];
  history: DiscoveryHistory;
  seed: string;
  now?: number;
  limit?: number;
  exclude?: readonly WereadBook[];
}): WereadBook[] {
  const { owned, history, seed, now = Date.now(), limit = 20, exclude = [] } = options;
  if (limit <= 0) return [];
  const interests = new Map<string, number>();
  const activity = new Map<string, number>();
  for (const session of options.sessions ?? []) {
    if (session.seconds >= 30) activity.set(session.bookId, Math.max(activity.get(session.bookId) ?? 0, session.endedAt));
  }
  const recent = owned.filter((book) => book.format !== "demo" &&
    ((book.readingPosition?.percent ?? 0) > 0 || (book.listeningPosition?.percent ?? 0) > 0 || activity.has(book.id)))
    .sort((a, b) => Math.max(b.readingPosition?.updatedAt ?? 0, b.listeningPosition?.updatedAt ?? 0, activity.get(b.id) ?? 0) -
      Math.max(a.readingPosition?.updatedAt ?? 0, a.listeningPosition?.updatedAt ?? 0, activity.get(a.id) ?? 0)).slice(0, 6);
  for (const book of recent) {
    const match = pool.find((item) => isOwnedBook(item, [book]));
    if (match) interests.set(categoryOf(match), 1);
  }
  for (const entry of Object.values(history)) {
    if (entry.openedAt > now - 30 * DAY_MS && !entry.hidden && entry.category) {
      interests.set(categoryOf(entry), 1);
    }
  }

  const excluded = new Set(exclude.map(discoveryKey));
  const unique = new Map<string, WereadBook>();
  for (const book of pool) {
    const key = discoveryKey(book);
    if (excluded.has(key) || history[key]?.hidden || isOwnedBook(book, owned)) continue;
    const previous = unique.get(key);
    if (!previous || (book.ratingCount ?? 0) > (previous.ratingCount ?? 0)) unique.set(key, book);
  }
  const candidates = [...unique].map(([key, book]) => {
    const feedback = history[key];
    const tier = !feedback?.seenAt ? 0 : now - feedback.seenAt >= EXPOSURE_COOLDOWN_MS ? 1 : 2;
    const count = book.ratingCount ?? 0;
    const quality = ((book.rating ?? 750) * count + 750 * 500) / (count + 500) / 1000;
    const ignored = feedback && !feedback.openedAt ? Math.min(feedback.impressions, 6) * 0.04 : 0;
    const score = quality * 0.3 + (interests.has(categoryOf(book)) ? 0.3 : 0) +
      discoveryHash(`${seed}:${key}`) / 0x1_0000_0000 * 0.6 - ignored;
    return { book, tier, score };
  }).sort((a, b) => a.tier - b.tier || b.score - a.score || a.book.bookId.localeCompare(b.book.bookId));

  const chosen: WereadBook[] = [];
  const keys = new Set<string>();
  const categories = new Map<string, number>();
  const authors = new Map<string, number>();
  // 先取未曝光作品；每个新鲜度层内先保证题材、作者多样，再放宽配额补齐。
  for (let tier = 0; tier <= 2; tier += 1) {
    for (const diverse of [true, false]) {
      for (const { book, tier: candidateTier } of candidates) {
        if (candidateTier !== tier || keys.has(discoveryKey(book))) continue;
        const category = categoryOf(book);
        const author = normalizedAuthor(book);
        if (diverse && ((categories.get(category) ?? 0) >= Math.ceil(limit / 4) ||
          (author && (authors.get(author) ?? 0) >= 2))) continue;
        keys.add(discoveryKey(book));
        categories.set(category, (categories.get(category) ?? 0) + 1);
        if (author) authors.set(author, (authors.get(author) ?? 0) + 1);
        chosen.push(book);
        if (chosen.length >= limit) return interleaveCategories(chosen);
      }
    }
  }
  return interleaveCategories(chosen);
}

export interface DiscoveryBoard {
  category: string;
  kind: RankingKind;
  entries: { book: WereadBook; rank: number }[];
  generatedAt: string;
}

/** 日轮换/主动换榜只改变展示区段；编号始终是完整榜中的真实名次。 */
export function selectDiscoveryBoard(catalogs: readonly StoreCatalog[], day: string, turn = 0): DiscoveryBoard | null {
  if (!catalogs.length) return null;
  const ordinal = Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
  for (let step = 0; step < catalogs.length * RANKING_KINDS.length; step += 1) {
    const index = ordinal + turn + step;
    const catalog = catalogs[((index % catalogs.length) + catalogs.length) % catalogs.length];
    const kind = RANKING_KINDS[((index % RANKING_KINDS.length) + RANKING_KINDS.length) % RANKING_KINDS.length];
    const ranked = rankOf(catalog.books, 60, kind);
    if (!ranked.length) continue;
    const pages = Math.ceil(ranked.length / 3);
    const offset = Math.min(discoveryHash(`${day}:${turn}:${catalog.category}:${kind}`) % pages * 3,
      Math.max(0, ranked.length - 3));
    return {
      category: catalog.category, kind, generatedAt: catalog.generatedAt,
      entries: ranked.slice(offset, offset + 3).map((book, i) => ({ book, rank: offset + i + 1 })),
    };
  }
  return null;
}
