import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DAY_MS, discoveryDay, discoveryKey, feedbackFor, isOwnedBook, selectDiscoveryBoard,
  selectDiscoveryBooks, type DiscoveryHistory,
} from "../lib/store-discovery.ts";
import { rankOf, type StoreCatalog } from "../lib/store-catalog.ts";
import type { WereadBook } from "../lib/weread-types.ts";
import type { BookMeta } from "../lib/types.ts";

const index = JSON.parse(readFileSync(new URL("../public/catalog/index.json", import.meta.url), "utf8"));
const catalogs: StoreCatalog[] = index.categories.map(({ slug }: { slug: string }) =>
  JSON.parse(readFileSync(new URL(`../public/catalog/${slug}.json`, import.meta.url), "utf8")));
const pool = catalogs.flatMap((catalog) => catalog.books.map((book) => ({ ...book, category: book.category ?? catalog.category })));
const now = new Date(2026, 9, 21, 12).getTime();

function book(id: string, overrides: Partial<WereadBook> = {}): WereadBook {
  return {
    bookId: id, title: `作品${id}`, author: `作者${id}`, category: "主题0", translator: null,
    coverUrl: null, intro: null, rating: 900, ratingCount: 1000, ratingLabel: null, readingCount: 100,
    ...overrides,
  };
}

test("真实书池连续换 20 批：候选充足时没有重复作品，题材保持多样", () => {
  const history: DiscoveryHistory = {};
  const seen = new Set<string>();
  let previous: WereadBook[] = [];
  for (let batch = 0; batch < 20; batch += 1) {
    const next = selectDiscoveryBooks(pool, { owned: [], history, seed: `2026-10-21:${batch}`, exclude: previous, now });
    assert.equal(next.length, 20);
    assert.ok(new Set(next.map((item) => item.category?.split("-")[0])).size >= 3);
    assert.ok(new Set(next.slice(0, 8).map((item) => item.category?.split("-")[0])).size >= 3,
      "主页露出的前8本也应覆盖多种题材");
    for (const item of next) {
      const key = discoveryKey(item);
      assert.ok(!seen.has(key), `第${batch}批重复了 ${item.title}`);
      seen.add(key);
      history[key] = { ...feedbackFor(history, item), seenAt: now, seenDay: discoveryDay(now), impressions: 1 };
    }
    previous = next;
  }
  assert.equal(seen.size, 400);
});

test("同一作品的版本后缀、国别与标点不造成重复；同名不同作者仍可区分", () => {
  const first = book("a", { title: "瓦尔登湖（精装典藏版）", author: "[美] 亨利·梭罗" });
  const second = book("b", { title: "瓦尔登湖（新版）", author: "【美】亨利•梭罗" });
  assert.equal(discoveryKey(first), discoveryKey(second));
  assert.ok(isOwnedBook(second, [first]));
  assert.ok(!isOwnedBook(second, [{ title: "瓦尔登湖", author: "另一位作者" }]));
  assert.equal(selectDiscoveryBooks([first, second], { owned: [], history: {}, seed: "a" }).length, 1);
});

test("已入库和不感兴趣的作品排除全部版本，不足时不会强行塞回来", () => {
  const owned = book("owned", { title: "已有作品（旧版）" });
  const hidden = book("hidden");
  const allowed = book("allowed");
  const history = { [discoveryKey(hidden)]: { ...feedbackFor({}, hidden), hidden: true } };
  const results = selectDiscoveryBooks([owned, { ...owned, bookId: "edition", title: "已有作品（新版）" }, hidden, allowed], {
    owned: [owned as unknown as BookMeta], history, seed: "filtered", now,
  });
  assert.deepEqual(results.map((item) => item.bookId), ["allowed"]);
  assert.deepEqual(selectDiscoveryBooks([hidden], { owned: [], history, seed: "empty" }), []);
});

test("只记曝光、不把下载到的候选全当已看过；冷却到期比刚看过的优先", () => {
  const fresh = book("fresh");
  const expired = book("expired");
  const recent = book("recent");
  const history: DiscoveryHistory = {
    [discoveryKey(expired)]: { ...feedbackFor({}, expired), seenAt: now - 8 * DAY_MS },
    [discoveryKey(recent)]: { ...feedbackFor({}, recent), seenAt: now - DAY_MS },
  };
  assert.deepEqual(selectDiscoveryBooks([recent, expired, fresh], { owned: [], history, seed: "tiers", now })
    .map((item) => item.bookId), ["fresh", "expired", "recent"]);
});

test("同一日期批次结果稳定，日期和批次变化会改变选择", () => {
  const options = { owned: [], history: {}, seed: "2026-10-21:0", now };
  const first = selectDiscoveryBooks(pool, options).map(discoveryKey);
  assert.deepEqual(selectDiscoveryBooks(pool, options).map(discoveryKey), first);
  assert.notDeepEqual(selectDiscoveryBooks(pool, { ...options, seed: "2026-10-22:0" }).map(discoveryKey), first);
  assert.notDeepEqual(selectDiscoveryBooks(pool, { ...options, seed: "2026-10-21:1" }).map(discoveryKey), first);
  assert.deepEqual(selectDiscoveryBooks(pool, { ...options, limit: 0 }), []);
});

test("真实阅读影响偏好；只打开书架文件不会误判为已阅读", () => {
  const candidates = Array.from({ length: 180 }, (_, i) => book(String(i), { category: `主题${i % 6}` }));
  const imported = { ...candidates[0], id: "local", format: "txt" } as unknown as BookMeta;
  const read = { ...imported, readingPosition: { percent: 0.2, updatedAt: now } } as BookMeta;
  let baseline = 0;
  let personalized = 0;
  for (let batch = 0; batch < 30; batch += 1) {
    const options = { history: {}, seed: `preference:${batch}`, now };
    baseline += selectDiscoveryBooks(candidates, { ...options, owned: [imported] }).filter((item) => item.category === "主题0").length;
    personalized += selectDiscoveryBooks(candidates, { ...options, owned: [read] }).filter((item) => item.category === "主题0").length;
  }
  assert.ok(personalized > baseline, `${personalized} 应高于 ${baseline}`);
});

test("三类榜按实际字段排序；热读不假造人数，小众榜保持可信评分门槛", () => {
  const items = [
    book("quality", { rating: 980, ratingCount: 20_000, readingCount: 10 }),
    book("popular", { rating: 870, ratingCount: 500, readingCount: 1000 }),
    book("hidden", { rating: 950, ratingCount: 800, readingCount: null }),
    book("untrusted", { rating: 1000, ratingCount: 20, readingCount: 50 }),
  ];
  assert.deepEqual(rankOf(items, 60).map((item) => item.bookId), ["quality", "hidden", "popular"]);
  assert.deepEqual(rankOf(items, 60, "popular").map((item) => item.bookId), ["popular", "untrusted", "quality"]);
  assert.deepEqual(rankOf(items, 60, "hidden").map((item) => item.bookId), ["hidden", "popular"]);
  assert.equal(items[0].bookId, "quality", "不得修改源数组顺序");
});

test("首页跨日和换榜可发现不同书，卡片名次始终对应完整榜", () => {
  const seen = new Set<string>();
  const original = JSON.stringify(catalogs);
  for (let day = 21; day <= 27; day += 1) {
    for (let turn = 0; turn < 3; turn += 1) {
      const board = selectDiscoveryBoard(catalogs, `2026-10-${day}`, turn);
      assert.ok(board);
      assert.equal(board.entries.length, 3);
      const source = catalogs.find((catalog) => catalog.category === board.category)!;
      const ranked = rankOf(source.books, 60, board.kind);
      for (const entry of board.entries) {
        assert.equal(entry.book.bookId, ranked[entry.rank - 1].bookId);
        seen.add(entry.book.bookId);
      }
    }
  }
  assert.ok(seen.size >= 30, `7天至少发现30本，实际${seen.size}`);
  assert.equal(JSON.stringify(catalogs), original);
});

test("本地日期按本地午夜切换，不使用 UTC 日期分界", () => {
  assert.equal(discoveryDay(new Date(2026, 9, 21, 0, 5).getTime()), "2026-10-21");
  assert.equal(discoveryDay(new Date(2026, 9, 20, 23, 59).getTime()), "2026-10-20");
});
