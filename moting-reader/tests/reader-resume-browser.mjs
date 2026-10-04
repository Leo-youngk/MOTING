// Real-book regression on a 390×844 touch viewport. Requires an external
// public-domain TXT path and Playwright Chromium; this does not emulate iOS WebKit.
// READER_BOOK_PATH=/path/to/novel.txt BROWSER_PATH=/path/to/headless_shell \
// CODEX_PRIMARY_RUNTIME_NODE_MODULES=/path/to/node_modules node tests/reader-resume-browser.mjs http://127.0.0.1:5173
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES || process.cwd()] }));
const path = process.env.READER_BOOK_PATH;
if (!path) throw new Error('READER_BOOK_PATH must point to an actual book TXT file');
const title = basename(path).replace(/\.[^.]+$/, '');
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, serviceWorkers: 'block' });
const page = await context.newPage();
const base = process.argv[2] || 'http://127.0.0.1:5173';
try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '书库', exact: true }).click();
  await page.locator('input[type="file"]').first().setInputFiles(path);
  const book = page.locator('article button', { hasText: title }).first();
  await book.waitFor({ timeout: 60000 });
  await book.click();
  await page.locator('.reader-article').waitFor();
  await page.waitForTimeout(1300);
  for (const y of [750, 1900, 4500, 10000]) {
    await page.evaluate(value => window.scrollTo(0, value), y);
    await page.waitForTimeout(1400);
    const before = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(k => k.startsWith('moting:pos:'));
      const position = JSON.parse(localStorage.getItem(key));
      const element = document.querySelector(`[data-sentence-id="${position.sentenceId}"]`);
      return { id: position.sentenceId, top: element.getBoundingClientRect().top, offset: position.anchorOffset };
    });
    assert.ok(Math.abs(before.top - (150 - before.offset)) < 2, `precondition: saved anchor at ${y}`);
    await page.getByRole('button', { name: '返回书架' }).click();
    await page.locator('article button', { hasText: title }).first().click();
    await page.locator('.reader-article').waitFor();
    await page.waitForTimeout(1650);
    const after = await page.evaluate(id => document.querySelector(`[data-sentence-id="${id}"]`)?.getBoundingClientRect().top, before.id);
    assert.ok(after !== undefined && Math.abs(after - before.top) <= 4, `scroll ${y}: saved ${before.top}px, restored ${after}px`);
    console.log(JSON.stringify({ scroll: y, driftPx: Math.round(after - before.top) }));
  }
  // An actual touch/drag must stop the initial restoration without dragging the reader back.
  await page.getByRole('button', { name: '返回书架' }).click();
  await page.locator('article button', { hasText: title }).first().click();
  await page.locator('.reader-article').waitFor();
  await page.evaluate(() => {
    window.dispatchEvent(new Event('touchstart'));
    window.scrollTo(0, 3000);
  });
  const touched = await page.evaluate(() => scrollY);
  await page.waitForTimeout(1700);
  const afterTouch = await page.evaluate(() => scrollY);
  assert.ok(Math.abs(afterTouch - touched) <= 2, `touch interrupted restore: ${touched} -> ${afterTouch}`);
  console.log('touch interruption: ok');
} finally { await browser.close(); }
