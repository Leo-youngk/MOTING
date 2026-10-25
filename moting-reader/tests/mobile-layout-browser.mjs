// BROWSER_PATH=/path/to/chromium node tests/mobile-layout-browser.mjs http://127.0.0.1:5173
// Local app only. Safe areas and keyboard geometry are fixtures, not iPhone hardware.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve("playwright", {
  paths: [process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES || process.cwd()],
}));
const base = process.argv[2] || "http://127.0.0.1:5173";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
const output = new URL("../.wrangler/mobile-layout/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}),
});
const context = await browser.newContext({
  viewport: { width: 440, height: 956 },
  isMobile: true, hasTouch: true, deviceScaleFactor: 3, serviceWorkers: "block",
  reducedMotion: "reduce",
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await page.route("**/api/weread/**", route => route.fulfill({ status: 503, json: { error: "Fixture: offline" } }));
await page.route("**/api/book-metadata/**", route => route.fulfill({ json: { candidates: [] } }));
await page.route("**/api/tts", route => route.fulfill({ status: 503, json: { error: "Fixture: no synthesis" } }));
await page.route("**/api/zlibrary/**", route => route.fulfill({ json: { connected: false } }));
// Optional CJK font for screenshot review on Linux hosts without Chinese system fonts.
const fontDir = process.env.TEST_FONT_DIR;
if (fontDir) {
  await page.route("**/layout-fixture-fonts/*", async route => {
    const filename = new URL(route.request().url()).pathname.split("/").pop();
    await route.fulfill({ body: await readFile(join(fontDir, "files", filename)), contentType: "font/woff2" });
  });
}
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
let size, safe;
async function layout(width, height, insets) {
  size = { width, height };
  safe = insets;
  await page.setViewportSize(size);
  await page.evaluate(insets => {
    for (const [edge, value] of Object.entries(insets)) document.documentElement.style.setProperty(`--safe-${edge}`, `${value}px`);
    dispatchEvent(new Event("resize"));
  }, insets);
  await settle();
}
async function noOverflow() {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "page overflows horizontally");
}
async function safeBox(selector, vertical = false) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, selector);
  assert.ok(box.x >= safe.left - 1 && box.x + box.width <= size.width - safe.right + 1, `${selector}: unsafe horizontal bounds ${JSON.stringify(box)}`);
  if (vertical) assert.ok(box.y >= safe.top - 1 && box.y + box.height <= size.height - safe.bottom + 1, `${selector}: unsafe vertical bounds ${JSON.stringify(box)}`);
  return box;
}
async function tapTarget(selector) {
  const box = await page.locator(selector).first().boundingBox();
  assert.ok(box?.width >= 44 && box.height >= 44, `${selector}: touch target ${JSON.stringify(box)}`);
}
async function traverse(view) {
  await page.evaluate(view => {
    history.pushState({ view, depth: 1 }, "");
    dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  }, view);
  await settle();
}
async function visualViewport(height, top = 0, scale = 1) {
  await page.evaluate(({ height, top, scale }) => {
    const viewport = window.visualViewport;
    for (const [key, value] of Object.entries({ height, offsetTop: top, scale })) {
      Object.defineProperty(viewport, key, { configurable: true, value });
    }
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
  }, { height, top, scale });
  await settle();
}
async function keyboardOpen(expected) {
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-keyboard-open")), expected);
}
const portrait = { top: 62, bottom: 34, left: 0, right: 0 };
try {
  await page.goto(base);
  await page.getByRole("button", { name: "书库", exact: true }).waitFor({ timeout: 60000 });
  if (fontDir) {
    const css = (await readFile(join(fontDir, "400.css"), "utf8")).replaceAll("./files/", "/layout-fixture-fonts/");
    await page.addStyleTag({ content: css + ":root{--font-sans:'Noto Sans SC',sans-serif}" });
    await page.evaluate(() => document.fonts.ready);
  }
  await layout(440, 956, portrait);
  await safeBox(".bottom-nav", true);
  await page.screenshot({ path: new URL("home.png", output).pathname });

  await page.getByRole("button", { name: "书库", exact: true }).click();
  await page.locator(".grid-book").first().waitFor();
  for (const [width, height] of [[375, 812], [390, 844], [430, 932], [440, 956], [440, 796]]) {
    await layout(width, height, portrait);
    await noOverflow();
    await safeBox(".bottom-nav", true);
    assert.equal(await page.locator(".book-grid").evaluate(el => getComputedStyle(el).gridTemplateColumns.split(" ").length), 3);
    await tapTarget(".grid-book__more");
  }
  await layout(440, 956, portrait);
  await page.screenshot({ path: new URL("library.png", output).pathname });
  await page.locator(".grid-book__cover").first().click();
  await page.locator(".reader-article").waitFor();
  const bookId = await page.evaluate(() => history.state.view.bookId);
  await tapTarget(".reader-chrome__back");
  await tapTarget(".reader-chrome__menu");
  await safeBox(".reader-chrome__menu", true);

  for (const side of ["left", "right"]) {
    await layout(956, 440, { top: 0, bottom: 21, left: side === "left" ? 62 : 0, right: side === "right" ? 62 : 0 });
    await safeBox(".reader-article");
    await safeBox(".reader-chrome__back", true);
    await safeBox(".reader-chrome__menu", true);
    await noOverflow();
  }
  await layout(440, 956, portrait);
  await page.getByRole("button", { name: "阅读菜单", exact: true }).click();
  await page.getByRole("button", { name: "目录", exact: true }).click();
  await settle();
  const catalog = await safeBox(".modal-sheet--toc");
  assert.ok(catalog.y >= portrait.top);
  await safeBox(".toc__close", true);
  const tocPadding = await page.locator(".toc").evaluate(el => parseFloat(getComputedStyle(el).paddingTop));
  assert.ok(tocPadding < portrait.top, "catalog repeats status-bar padding");
  await page.locator(".toc__close").click();
  await page.locator(".modal-backdrop").waitFor({ state: "detached" });

  await page.getByRole("button", { name: "阅读菜单", exact: true }).click();
  await page.getByRole("button", { name: "问 AI", exact: true }).click();
  await page.locator(".ai-chat").waitFor();
  const input = page.locator(".ai-chat textarea");
  await tapTarget(".ai-chat__send");
  const composer = await safeBox(".ai-chat__composer");
  assert.ok(composer.y + composer.height <= 957);
  assert.ok(await page.locator(".ai-chat__composer").evaluate(el => parseFloat(getComputedStyle(el).paddingBottom) >= 34));
  await input.focus();
  await visualViewport(880); // Toolbar, not keyboard.
  await keyboardOpen(false);
  await visualViewport(560);
  await keyboardOpen(true);
  await input.fill("请结合原书解释这个问题，保留作者的限定条件。".repeat(8));
  await settle();
  for (const [height, top] of [[560, 0], [420, 160], [520, 436]]) {
    await visualViewport(height, top);
    await keyboardOpen(true);
    const chat = await page.locator(".ai-chat").boundingBox();
    const field = await input.boundingBox();
    assert.ok(Math.abs(chat.y - top) <= 1 && Math.abs(chat.height - height) <= 1);
    assert.ok(field.y >= top && field.y + field.height <= top + height);
    assert.ok(await input.evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 16));
  }
  await page.screenshot({ path: new URL("chat-keyboard.png", output).pathname });
  await input.blur();
  await settle();
  await keyboardOpen(true); // Preserve geometry during dismissal animation.
  await visualViewport(956);
  await keyboardOpen(false);
  await input.focus();
  await visualViewport(560, 0, 1.5); // Pinch zoom is not a keyboard.
  await keyboardOpen(false);
  await visualViewport(956);
  await input.blur();
  await page.locator(".ai-chat__close").click();
  await page.locator(".ai-chat").waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.body.classList.contains("is-scroll-locked")), false);
  console.log("portrait, rotation, catalog and keyboard checks passed");

  await traverse({ name: "listen" });
  await traverse({ name: "player", bookId });
  await page.locator(".player-screen").waitFor();
  await safeBox(".player-tools", true);
  await tapTarget(".player-seek input");
  await page.screenshot({ path: new URL("player.png", output).pathname });
  for (const [width, height] of [[956, 440], [980, 440], [844, 390]]) {
    await layout(width, height, { top: 0, bottom: 21, left: 62, right: 0 });
    const stage = await safeBox(".player-stage", true);
    const tools = await safeBox(".player-tools", true);
    assert.ok(stage.x + stage.width <= tools.x + 1, "landscape controls are not beside cover");
    await noOverflow();
  }
  await page.screenshot({ path: new URL("landscape.png", output).pathname });
  await layout(440, 956, portrait);
  await page.locator(".player-primary-control").click();
  await page.locator(".player-header").getByRole("button", { name: "返回", exact: true }).click();
  await page.locator(".mini-player").waitFor();
  const mini = await safeBox(".mini-player", true);
  const nav = await safeBox(".bottom-nav", true);
  assert.ok(mini.y + mini.height <= nav.y - 7, "mini player overlaps tabs");
  await tapTarget(".mini-player__toggle");
  await tapTarget(".mini-player__stop");
  await traverse({ name: "find", query: "" });
  await page.getByLabel("在线搜索书名或作者").waitFor();
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("dialog", { name: "Z-Library 账号" }).waitFor();
  await page.getByLabel("邮箱", { exact: true }).focus();
  await visualViewport(440, 100);
  await keyboardOpen(true);
  assert.equal(await page.locator(".mini-player").isVisible(), false);
  const sheet = await page.locator(".modal-sheet").boundingBox();
  assert.ok(sheet.y >= 100 + portrait.top && sheet.y + sheet.height <= 541, JSON.stringify(sheet));
  await page.getByLabel("邮箱", { exact: true }).blur();
  await visualViewport(956);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator(".modal-backdrop").waitFor({ state: "detached" });
  await traverse({ name: "settings" });
  await page.locator(".settings-screen").waitFor();
  for (const shell of ["white", "cream", "black"]) {
    await page.evaluate(shell => document.documentElement.setAttribute("data-shell", shell), shell);
    await noOverflow();
    await safeBox(".page-bar__back", true);
  }
  await layout(956, 440, { top: 0, bottom: 21, left: 62, right: 0 });
  await safeBox(".page-bar__back", true);
  await noOverflow();
  await traverse({ name: "home" });
  await page.locator(".ios-header").first().waitFor();
  assert.equal(await page.locator(".desktop-brand").isVisible(), false, "phone landscape activates desktop sidebar");
  await layout(1024, 768, { top: 0, bottom: 0, left: 0, right: 0 });
  assert.equal(await page.locator(".desktop-brand").isVisible(), true, "desktop sidebar regressed");
  assert.deepEqual(errors, []);
  console.log("mobile-layout-browser: portrait, both rotations, Safari-height, touch, catalog, chat, keyboard, forms, themes and desktop checks passed");
} catch (error) {
  await page.screenshot({ path: new URL("failure.png", output).pathname });
  throw error;
} finally {
  await context.close();
  await browser.close();
}
