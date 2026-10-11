// BROWSER_PATH=/path/to/chromium node tests/navigation-browser.mjs http://127.0.0.1:5173
// Local production app, fixture shelves, real History / IndexedDB / Portal behavior.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve("playwright", { paths: [process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES || process.cwd()] }));
const base = process.argv[2] || "http://127.0.0.1:5173";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await page.route("**/api/weread/**", route => route.fulfill({ status: 503, json: { error: "Fixture: upstream unavailable" } }));
await page.route("**/api/book-metadata/**", route => route.fulfill({ json: { candidates: [] } }));
const traverse = async view => {
  await page.evaluate(view => {
    history.pushState({ view, depth: 1 }, "");
    dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  }, view);
};
const unlocked = async () => {
  await page.locator(".modal-backdrop").first().waitFor({ state: "detached" });
  assert.equal(await page.locator(".modal-backdrop").count(), 0);
  assert.equal(await page.evaluate(() => document.body.classList.contains("is-scroll-locked")), false);
};
try {
  await page.goto(base);
  await page.getByRole("button", { name: "书库", exact: true }).click();
  await page.locator(".grid-book").first().waitFor();
  const realLabel = await page.locator(".grid-book__cover").first().getAttribute("aria-label");
  await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open("moting-reader");
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("books", "readwrite");
      const store = tx.objectStore("books");
      const all = store.getAll();
      all.onsuccess = () => {
        const book = all.result[0];
        for (let index = 0; index < 24; index++) store.put({ ...book, id: `nav-fixture-${index}`, title: `切页测试${index}`, fileHash: `fixture-${index}` });
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  await page.reload();
  await page.locator(".grid-book").nth(23).waitFor();
  await page.evaluate(() => { document.querySelector(".book-grid").__kept = true; scrollTo(0, 600); });
  await page.locator(".grid-book__more").nth(5).click();
  await page.getByRole("dialog").waitFor();
  const savedScroll = await page.evaluate(() => -parseFloat(document.body.style.top));
  await traverse({ name: "find" });
  await page.getByLabel("在线搜索书名或作者").waitFor();
  await unlocked();
  assert.equal(await page.evaluate(() => scrollY), 0);
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.waitForFunction(y => Math.abs(scrollY - y) <= 2, savedScroll);
  assert.equal(await page.evaluate(() => document.querySelector(".book-grid").__kept), true);
  await unlocked();
  console.log("hidden shelf: Portal removed, scroll restored, original DOM retained");

  await page.locator(".grid-book__more").first().click();
  await page.getByRole("button", { name: "书籍资料", exact: true }).click();
  await page.getByRole("dialog", { name: "书籍资料" }).waitFor();
  await traverse({ name: "settings" });
  await page.locator(".settings-screen").waitFor();
  await unlocked();
  await page.goBack();
  await page.locator(".book-grid").waitFor();
  await unlocked();
  console.log("global book panel: history traversal closes the previous page overlay");

  await page.locator(".grid-book__more").first().click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await traverse({ name: "find" });
  await unlocked();
  await page.waitForTimeout(400);
  await page.goBack();
  await page.locator(".book-grid").waitFor();
  await unlocked();
  console.log("closing animation: old timers and scroll locks do not leak across pages");

  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.get;
    const descriptor = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "onsuccess");
    IDBObjectStore.prototype.get = function(...args) {
      const request = original.apply(this, args);
      if (this.name === "contents") {
        Object.defineProperty(request, "onsuccess", {
          set(handler) { descriptor.set.call(request, event => { window.__delayedBookRead = true; setTimeout(() => handler.call(request, event), 700); }); },
        });
      }
      return request;
    };
  });
  await page.getByRole("button", { name: realLabel, exact: true }).click();
  await page.waitForFunction(() => window.__delayedBookRead);
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.waitForTimeout(1000);
  assert.equal(await page.locator(".reader-article").count(), 0);
  await page.getByRole("heading", { name: "笔记", exact: true }).waitFor();
  console.log("async book open: delayed content read cannot pull the user back after a tab switch");

  for (const width of [375, 390, 430, 900]) {
    await page.setViewportSize({ width, height: 844 });
    for (const name of ["书库", "听书", "笔记", "主页", "书库"]) await page.getByRole("button", { name, exact: true }).click();
    await page.locator(".app-frame").waitFor();
    await page.locator(".app-tab-content").waitFor();
    await unlocked();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  assert.deepEqual(errors, []);
  console.log("navigation-browser: all checks passed at 375/390/430/900px");
} finally {
  await browser.close();
}
