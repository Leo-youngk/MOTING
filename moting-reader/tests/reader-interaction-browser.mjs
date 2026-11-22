// Run against a local production build. MOTING_BROWSER_ENGINE=webkit also exercises desktop WebKit.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const engines = require(require.resolve("playwright", { paths: [process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES || process.cwd()] }));
const base = process.argv[2] || "http://127.0.0.1:4173";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
const browser = await engines[process.env.MOTING_BROWSER_ENGINE || "chromium"].launch({
  headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 440, height: 956 }, hasTouch: true, isMobile: true, serviceWorkers: "block" });
const button = (name) => page.getByRole("button", { name, exact: true });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await page.route("**/api/**", route => route.fulfill({ status: 503, json: { error: "offline fixture" } }));
const title = "翻页手势测试";
const chapter = ("一段足以在手机上排成多行的正文。".repeat(8) + "\n\n").repeat(30);
try {
  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.fetch = function(input, init) {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/api/sync/session") && window.firstSessionAfterShelf === undefined) {
        window.firstSessionAfterShelf = Boolean(document.querySelector(".bottom-nav"));
      }
      return fetch.call(this, input, init);
    };
  });
  await page.goto(base);
  await button("书库").click();
  assert.equal(await page.evaluate(() => window.firstSessionAfterShelf), true, "local shelf precedes the first session check");
  await page.locator('input[type="file"]').setInputFiles({
    name: title + ".md", mimeType: "text/markdown",
    buffer: Buffer.from("# " + title + "\n\n" + chapter + "# 第二章\n\n" + chapter),
  });
  const cover = button("阅读" + title);
  await cover.waitFor();
  const shelfSearch = page.getByPlaceholder("搜索书名或作者", { exact: true });
  await shelfSearch.fill(title);
  await button("听书").click();
  const listenSearch = page.getByPlaceholder("搜索可听书籍");
  await listenSearch.fill("墨听");
  await button("书库").click();
  assert.equal(await shelfSearch.inputValue(), title);

  await page.evaluate(() => {
    const getAll = IDBObjectStore.prototype.getAll;
    window.shelfScans = 0;
    IDBObjectStore.prototype.getAll = function (...args) {
      if (this.name === "books") window.shelfScans++;
      return getAll.apply(this, args);
    };
  });
  await cover.click();
  const article = page.locator(".reader-article");
  await article.waitFor();
  assert.equal(await page.evaluate(() => window.shelfScans), 0, "opening one book must not read every cover");
  await button("阅读菜单").click();
  await button("主题与设置").click();
  await button("左右翻页").click();
  const sheet = page.getByRole("dialog");
  const grabber = sheet.locator(".modal-grabber");
  const pointer = (type, x, y, target) => target.dispatchEvent(type, {
    pointerType: "touch", pointerId: 4, isPrimary: true, button: 0, clientX: x, clientY: y, bubbles: true,
  });
  await pointer("pointerdown", 200, 200, grabber);
  await pointer("pointermove", 200, 320, grabber);
  await pointer("pointercancel", 200, 320, grabber);
  await page.waitForTimeout(350);
  assert.ok(await sheet.isVisible(), "interrupted sheet drag must leave the sheet open");
  await sheet.getByRole("button", { name: "关闭", exact: true }).click();
  await sheet.waitFor({ state: "detached" });
  await page.evaluate(() => document.fonts.ready);
  const viewport = page.locator(".reader-viewport");
  const left = () => article.evaluate(el => el.getBoundingClientRect().left);
  const start = await left();
  const step = await article.evaluate(el => el.clientWidth + parseFloat(getComputedStyle(el).columnGap));
  const swipe = async (from, to, cancelled = false) => {
    await pointer("pointerdown", from, 360, viewport);
    await pointer("pointermove", to, 360, viewport);
    const release = await left();
    await pointer(cancelled ? "pointercancel" : "pointerup", to, 360, viewport);
    const frames = await article.evaluate(async el => {
      const positions = [];
      const until = performance.now() + 420;
      do {
        positions.push(el.getBoundingClientRect().left);
        await new Promise(requestAnimationFrame);
      } while (performance.now() < until);
      return positions;
    });
    return { release, frames, last: frames.at(-1) };
  };
  const forward = await swipe(340, 140);
  assert.ok(Math.abs(forward.release - start + 200) < 2, "the page follows the finger");
  assert.ok(Math.abs(forward.last - start + step) < 2, "one swipe turns one page");
  assert.ok(forward.frames.every(x => x <= forward.release + 2 && x >= forward.last - 2), "release must stay between finger and destination");
  const interrupted = await swipe(140, 310, true);
  assert.ok(Math.abs(interrupted.last - forward.last) < 2, "cancel returns to the same page");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const back = await swipe(140, 340);
  assert.ok(back.frames.every(x => Math.abs(x - start) < 2), "reduced motion must settle without intermediate frames");
  const edge = await swipe(140, 340);
  assert.ok(edge.release - start < 55 && Math.abs(edge.last - start) < 2, "first-page boundary");
  console.log("touch pagination: tracked, settled, cancelled, reduced motion, first-page edge");

  await button("返回书架").click();
  await button("听书").click();
  assert.equal(await listenSearch.inputValue(), "墨听");
  await listenSearch.fill("");
  await page.reload(); // Evict in-memory book content.
  const rows = page.locator(".ios-row--media");
  await rows.first().waitFor();
  await page.evaluate(() => {
    const get = IDBObjectStore.prototype.get;
    const success = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "onsuccess");
    let delayNextContent = true;
    IDBObjectStore.prototype.get = function (...args) {
      const request = get.apply(this, args);
      if (this.name === "contents" && delayNextContent) {
        delayNextContent = false;
        Object.defineProperty(request, "onsuccess", {
          set(handler) { success.set.call(request, event => { window.finishFirstOpen = () => handler.call(request, event); }); },
        });
      }
      return request;
    };
  });
  await rows.filter({ hasText: title }).locator(".ios-play-button").click();
  await page.waitForFunction(() => typeof window.finishFirstOpen === "function");
  const other = rows.filter({ hasNotText: title }).first();
  const otherTitle = await other.locator(".ios-row__main > span > strong").innerText();
  await other.locator(".ios-play-button").click();
  await page.locator(".player-title h1").waitFor();
  await page.evaluate(() => window.finishFirstOpen());
  await page.locator(".player-header").getByRole("button", { name: "返回", exact: true }).click();
  assert.ok((await page.locator(".mini-player__main").innerText()).includes(otherTitle), "late first click stopped newer playback");

  await page.locator(".mini-player__main").click();
  await button("更多").click();
  await button("查看原文").click();
  await article.waitFor();
  const depth = await page.evaluate(() => history.length);
  await page.reload();
  await article.waitFor();
  assert.equal(await page.evaluate(() => history.length), depth);
  await button("返回书架").click();
  await page.locator(".player-screen").waitFor();
  await page.locator(".player-header").getByRole("button", { name: "返回", exact: true }).click();
  await page.locator(".ios-play-button").first().waitFor();
  assert.deepEqual(errors, []);
  console.log("book opening: single-book read, cancelled playback request, tab search and real return path");
} finally {
  await browser.close();
}
