import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getDiscoveryState, isDiscoveryHidden, readDiscoveryHistory, recordBookExposure,
  setDiscoveryHidden, shuffleDiscovery, startDiscovery,
} from "../lib/store-snapshot.ts";
import { DAY_MS, discoveryDay, discoveryKey } from "../lib/store-discovery.ts";
import type { BookMeta } from "../lib/types.ts";

test("共享推荐状态：过期、换批、曝光、入库、撤销与跨日恢复", async (t) => {
  const stored = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); },
  };
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: { localStorage }, configurable: true });
  const fetches: string[] = [];
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const path = String(input);
    fetches.push(path);
    assert.match(path, /^\/catalog\/[a-z]+\.json$/);
    return Response.json(JSON.parse(readFileSync(new URL(`../public${path}`, import.meta.url), "utf8")));
  });
  let now = new Date(2026, 9, 21, 12).getTime();
  const clock = t.mock.method(Date, "now", () => now);
  stored.set("moting:store-discovery:v2", JSON.stringify({ feed: { day: "2026-09-22", batch: 0, books: [] } }));
  try {
    await startDiscovery([]);
    const initial = getDiscoveryState();
    assert.equal(initial.feed!.day, discoveryDay(now));
    assert.equal(initial.feed!.books.length, 20);
    assert.equal(fetches.length, 11);
    assert.equal(Object.keys(readDiscoveryHistory()).length, 0, "加载候选不算曝光");

    const visible = initial.feed!.books[0];
    recordBookExposure(visible);
    recordBookExposure(visible);
    assert.equal(readDiscoveryHistory()[discoveryKey(visible)].impressions, 1, "当天重复挂载不增加忽略次数");
    assert.equal(Object.keys(readDiscoveryHistory()).length, 1, "屏幕外的书不记曝光");

    await startDiscovery([]);
    assert.deepEqual(getDiscoveryState().feed, initial.feed, "切页或重进保留同一批次");
    assert.deepEqual(getDiscoveryState().board, initial.board);
    shuffleDiscovery();
    const next = getDiscoveryState().feed!;
    const previous = new Set(initial.feed!.books.map(discoveryKey));
    assert.ok(next.books.every((book) => !previous.has(discoveryKey(book))));
    assert.equal(fetches.length, 11, "换批没有新增网络请求");

    const hidden = next.books[0];
    setDiscoveryHidden(hidden, true);
    assert.ok(isDiscoveryHidden(hidden));
    assert.ok(getDiscoveryState().feed!.books.every((book) => discoveryKey(book) !== discoveryKey(hidden)));
    setDiscoveryHidden(hidden, false);
    assert.ok(!isDiscoveryHidden(hidden), "反馈可撤销");

    const imported = getDiscoveryState().feed!.books[0];
    const owned = { ...imported, id: "newly-imported", format: "txt" } as unknown as BookMeta;
    await startDiscovery([owned]);
    assert.ok(getDiscoveryState().feed!.books.every((book) => discoveryKey(book) !== discoveryKey(imported)));

    const beforeMidnight = getDiscoveryState().feed!;
    now += DAY_MS;
    await startDiscovery([owned]);
    assert.equal(getDiscoveryState().feed!.day, "2026-10-22");
    assert.notDeepEqual(getDiscoveryState().feed!.books, beforeMidnight.books);
    assert.equal(fetches.length, 11, "跨日轮换继续使用静态书池");

    const setItem = localStorage.setItem;
    localStorage.setItem = () => { throw new Error("storage disabled"); };
    const warnings = t.mock.method(console, "warn", () => {});
    const beforeBlocked = getDiscoveryState().feed!;
    shuffleDiscovery();
    assert.notDeepEqual(getDiscoveryState().feed!.books, beforeBlocked.books);
    assert.equal(warnings.mock.calls.length, 1, "隐私模式退回内存且记录状态");
    localStorage.setItem = setItem;
    warnings.mock.restore();
  } finally {
    clock.mock.restore();
    fetchMock.mock.restore();
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
