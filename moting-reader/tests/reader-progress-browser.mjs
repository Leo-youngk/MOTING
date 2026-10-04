// Real-book resume/lifecycle regression against an isolated local production server.
// READER_BOOK_PATH=/path/to/book.txt MOTING_BROWSER_ENGINE=webkit node tests/reader-progress-browser.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES || process.cwd()] }));
const engine = process.env.MOTING_BROWSER_ENGINE || "chromium";
const base = process.argv[2] || "http://127.0.0.1:5173";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname), "isolated local server required");
const path = process.env.READER_BOOK_PATH;
assert.ok(path, "READER_BOOK_PATH must contain an actual public-domain book");
const title = (await readFile(path, "utf8")).trimStart().split(/\r?\n/)[0];
const browser = await playwright[engine].launch({ headless: true,
  ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const checks = {};
const check = async (name, run) => {
  try { await run(); checks[name] = true; }
  catch (error) { checks[name] = error.message; }
  console.log(JSON.stringify({ [name]: checks[name] }));
};
const reader = page.locator(".reader-article");
const open = async () => {
  await page.locator("article button", { hasText: title }).first().click();
  await reader.waitFor();
};
const back = () => page.getByRole("button", { name: "返回书架" }).click();
const anchor = () => page.evaluate(() => {
  const article = document.querySelector(".reader-article");
  for (const y of [150, 144, 156, 132, 168, 180]) {
    for (const hit of document.elementsFromPoint(innerWidth / 2, y)) {
      const block = hit.closest(".reader-block");
      if (!block || !article.contains(block)) continue;
      for (const element of block.querySelectorAll("[data-sentence-id]")) {
        if ([...element.getClientRects()].some(rect => rect.top <= y && rect.bottom > y)) {
          return { id: element.dataset.sentenceId, top: element.getBoundingClientRect().top };
        }
      }
    }
  }
  return null;
});
const backup = () => page.evaluate(() => {
  const key = Object.keys(localStorage).find(key => key.startsWith("moting:pos:"));
  return key ? JSON.parse(localStorage.getItem(key)) : null;
});
const assertRestored = async (expected) => {
  await page.waitForTimeout(1700);
  const top = await page.evaluate(id => document.querySelector(`[data-sentence-id="${id}"]`)?.getBoundingClientRect().top, expected.id);
  assert.ok(top !== undefined && Math.abs(top - expected.top) <= 4, `saved ${expected.id} at ${expected.top}px; restored ${top}px`);
};
try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "书库", exact: true }).click();
  await page.locator('input[type="file"]').first().setInputFiles(path);
  await open();
  await page.waitForTimeout(1800);
  for (const y of [750, 4500, 12000]) {
    await check(`settled_resume_${y}`, async () => {
      await page.evaluate(y => scrollTo(0, y), y);
      await page.waitForTimeout(1500);
      const expected = await anchor();
      assert.ok(expected);
      await back(); await open();
      await assertRestored(expected);
    });
  }
  await check("fast_exit_flushes_exact_anchor", async () => {
    await page.evaluate(() => scrollBy(0, 400));
    await page.waitForTimeout(80);
    await page.evaluate(() => scrollBy(0, 920));
    await page.waitForTimeout(40);
    const expected = await anchor(); assert.ok(expected);
    await back(); await open(); await assertRestored(expected);
  });
  await check("pagehide_flushes_before_freeze", async () => {
    await page.evaluate(() => scrollBy(0, 1100));
    await page.waitForTimeout(40);
    const expected = await anchor(); assert.ok(expected);
    await page.evaluate(() => dispatchEvent(new Event("pagehide")));
    const saved = await backup();
    assert.equal(saved?.sentenceId, expected.id, "synchronous backup must contain the visible sentence before pagehide returns");
    assert.ok(Math.abs(150 - saved.anchorOffset - expected.top) <= 2);
    await page.reload(); await reader.waitFor(); await assertRestored(expected);
  });
  await check("touch_cancels_restore_without_bounce", async () => {
    await back(); await open();
    await page.evaluate(() => { dispatchEvent(new Event("touchstart")); scrollTo(0, 3000); });
    await page.waitForTimeout(50);
    const y = await page.evaluate(() => scrollY);
    await page.waitForTimeout(1700);
    assert.ok(Math.abs(await page.evaluate(() => scrollY) - y) <= 2);
  });
  await check("return_does_not_reload_document", async () => {
    await page.evaluate(() => { window.__readerDocument = "same"; });
    await back(); await open();
    assert.equal(await page.evaluate(() => window.__readerDocument), "same");
  });
  const actualBook = await page.evaluate(async () => {
    const db = await new Promise(resolve => { const request = indexedDB.open("moting-reader"); request.onsuccess = () => resolve(request.result); });
    const transaction = db.transaction(["books", "contents"]);
    const read = (store, key) => new Promise(resolve => { const request = transaction.objectStore(store).get(key); request.onsuccess = () => resolve(request.result); });
    const key = Object.keys(localStorage).find(key => key.startsWith("moting:pos:"));
    const id = key.slice("moting:pos:".length);
    const [meta, content] = await Promise.all([read("books", id), read("contents", id)]);
    db.close(); return { ...meta, chapters: content.chapters };
  });
  await check("complete_book_imported", async () => {
    assert.ok(actualBook.characterCount > 80000 && actualBook.chapters.length > 8);
    console.log(JSON.stringify({ characterCount: actualBook.characterCount, sentences: actualBook.sentenceCount, chapters: actualBook.chapters.length }));
  });
  for (const fraction of [0.5, 0.9]) {
    await check(`later_chapter_resume_${fraction}`, async () => {
      await back();
      const chapterIndex = Math.floor((actualBook.chapters.length - 1) * fraction);
      const chapter = actualBook.chapters[chapterIndex];
      const sentences = chapter.paragraphs.flatMap(paragraph => paragraph.sentences);
      const sentenceIndex = Math.floor(sentences.length * 0.6);
      const position = { chapterId: chapter.id, chapterIndex, sentenceId: sentences[sentenceIndex].id,
        sentenceIndex, percent: fraction * 100, anchorOffset: 17, updatedAt: Date.now() + 10 };
      // 模拟离线关闭时，同步兜底比 IndexedDB 更新；正文来自实际导入的完整书籍。
      await page.evaluate(({ id, position }) => localStorage.setItem(`moting:pos:${id}`, JSON.stringify(position)), { id: actualBook.id, position });
      await open();
      await assertRestored({ id: position.sentenceId, top: 133 });
      await page.evaluate(() => scrollBy(0, 700));
      await page.waitForTimeout(700);
      const expected = await anchor(); assert.ok(expected);
      await back(); await open(); await assertRestored(expected);
    });
  }
  await check("continuous_chapter_boundary_keeps_position", async () => {
    await page.evaluate(() => {
      const section = document.querySelector("[data-chapter-section]");
      scrollBy(0, section.getBoundingClientRect().bottom - innerHeight + 500);
    });
    await page.waitForTimeout(1300);
    const target = await page.evaluate(() => {
      const sections = [...document.querySelectorAll("[data-chapter-section]")];
      const section = sections[sections.length - 1];
      const sentences = [...section.querySelectorAll("[data-sentence-id]")];
      const target = sentences[Math.min(20, sentences.length - 1)];
      scrollBy(0, target.getBoundingClientRect().top - 150);
      return target.dataset.sentenceId;
    });
    await page.waitForTimeout(1600);
    const expected = await anchor(); assert.ok(expected && target);
    await back(); await open(); await assertRestored(expected);
  });
  await check("paged_fast_exit_keeps_same_page", async () => {
    await back();
    const chapter = actualBook.chapters[2];
    const sentence = chapter.paragraphs.flatMap(paragraph => paragraph.sentences)[20];
    await page.evaluate(({ id, position }) => {
      const key = `moting:pos:${id}`;
      const previous = JSON.parse(localStorage.getItem(key));
      localStorage.setItem(key, JSON.stringify({ ...position, updatedAt: Math.max(Date.now(), previous.updatedAt + 1) }));
    }, { id: actualBook.id, position: { chapterId: chapter.id, chapterIndex: 2, sentenceId: sentence.id,
      sentenceIndex: 20, percent: 25, anchorOffset: 0 } });
    await open(); await page.waitForTimeout(1700);
    await page.getByRole("button", { name: "阅读菜单" }).click();
    await page.getByRole("button", { name: "主题与设置" }).click();
    await page.getByRole("button", { name: "左右翻页" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.waitForTimeout(600);
    for (let i = 0; i < 4; i++) { await page.keyboard.press("ArrowRight"); await page.waitForTimeout(40); }
    const transform = await reader.evaluate(element => element.style.transform);
    await back(); await open(); await page.waitForTimeout(800);
    assert.equal(await reader.evaluate(element => element.style.transform), transform);
  });
  await check("paged_newer_backup_wins", async () => {
    await page.waitForTimeout(600);
    const candidate = await page.evaluate(() => {
      const article = document.querySelector(".reader-article");
      const step = article.clientWidth + parseFloat(getComputedStyle(article).columnGap);
      const sentences = [...article.querySelectorAll("[data-sentence-id]")];
      const target = sentences[Math.floor(sentences.length * 0.8)];
      const chapterIndex = Number(target.dataset.chapterIndex);
      return { id: target.dataset.sentenceId, index: Number(target.dataset.sentenceIndex), chapterIndex,
        targetPage: Math.floor((target.getBoundingClientRect().left - article.getBoundingClientRect().left + 1) / step), step };
    });
    const chapter = actualBook.chapters[candidate.chapterIndex];
    const position = { chapterId: chapter.id, chapterIndex: candidate.chapterIndex, sentenceId: candidate.id,
      sentenceIndex: candidate.index, percent: 95, pageOffset: 0, updatedAt: Date.now() + 20 };
    await page.evaluate(({ id, position }) => localStorage.setItem(`moting:pos:${id}`, JSON.stringify(position)), { id: actualBook.id, position });
    await page.reload(); await reader.waitFor(); await page.waitForTimeout(900);
    const transform = await reader.evaluate(element => element.style.transform);
    const shift = Number(/translateX\(([-.\d]+)px\)/.exec(transform)?.[1]);
    assert.ok(Math.abs(shift + candidate.targetPage * candidate.step) < 2, `backup page ${candidate.targetPage}; restored transform ${transform}`);
  });
  await check("sentence_crossing_pages_keeps_page_offset", async () => {
    const candidate = await page.evaluate(() => {
      const article = document.querySelector(".reader-article");
      const step = article.clientWidth + parseFloat(getComputedStyle(article).columnGap);
      const target = [...article.querySelectorAll("[data-sentence-id]")].find(element => {
        const lefts = [...element.getClientRects()].map(rect => rect.left);
        return Math.max(...lefts) - Math.min(...lefts) > step * 0.8;
      });
      if (!target) return null;
      return { id: target.dataset.sentenceId, index: Number(target.dataset.sentenceIndex), chapterIndex: Number(target.dataset.chapterIndex),
        targetPage: Math.floor((target.getBoundingClientRect().left - article.getBoundingClientRect().left + 1) / step) + 1, step };
    });
    assert.ok(candidate, "real book has a sentence spanning a page boundary");
    const chapter = actualBook.chapters[candidate.chapterIndex];
    await page.evaluate(({ id, position }) => {
      const key = `moting:pos:${id}`;
      const previous = JSON.parse(localStorage.getItem(key));
      localStorage.setItem(key, JSON.stringify({ ...position, updatedAt: Math.max(Date.now(), previous.updatedAt + 1) }));
    }, { id: actualBook.id, position: { chapterId: chapter.id, chapterIndex: candidate.chapterIndex, sentenceId: candidate.id,
      sentenceIndex: candidate.index, percent: 25, pageOffset: 1 } });
    await page.reload(); await reader.waitFor(); await page.waitForTimeout(800);
    const transform = await reader.evaluate(element => element.style.transform);
    const shift = Number(/translateX\(([-.\d]+)px\)/.exec(transform)?.[1]);
    assert.ok(Math.abs(shift + candidate.targetPage * candidate.step) < 2, `cross-page offset restored to ${transform}`);
    await back(); await open(); await page.waitForTimeout(700);
    assert.equal(await reader.evaluate(element => element.style.transform), transform);
  });
  await check("expired_asset_does_not_reload_reader", async () => {
    await page.evaluate(() => {
      window.__readerDocument = "same";
      navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "shell-expired" } }));
      navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "shell-expired" } }));
    });
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => window.__readerDocument), "same");
  });
  await check("no_script_errors", async () => assert.deepEqual(errors, []));
  console.log(JSON.stringify({ engine, checks }, null, 2));
  assert.ok(Object.values(checks).every(value => value === true), "reader progress regression failed");
} finally { await browser.close(); }
