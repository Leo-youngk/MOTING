// BROWSER_PATH=/path/to/headless-shell node tests/chat-history-browser.mjs http://127.0.0.1:4173
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve("playwright", { paths: [process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES || process.cwd()] }));
const origin = process.argv[2] || "http://127.0.0.1:4173";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH });
try {
  const page = await browser.newPage({ viewport: { width: 440, height: 956 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  await page.route("**/api/**", route => route.fulfill({ status: 503, json: {} }));
  await page.goto(origin);
  const button = name => page.getByRole("button", { name, exact: true });
  await button("书库").click();
  await page.evaluate(async () => {
    const db = await new Promise(resolve => { const r = indexedDB.open("moting-reader"); r.onsuccess = () => resolve(r.result); });
    const tx = db.transaction(["books","chats","settings"], "readwrite");
    const keys = tx.objectStore("books").getAllKeys();
    keys.onsuccess = () => {
      const turns = [];
      for (let i = 1; i <= 120; i++) turns.push(
        { id: "q"+i, role: "user", content: "历史问题 " + i },
        { id: "a"+i, replyTo: "q"+i, role: "assistant", content: ("### 历史回答 " + i + "\n\n" + "**正文**和例子。".repeat(18) + "\n\n").repeat(4) },
      );
      turns.push({ id: "unanswered", role: "user", content: "尚未收到回复" });
      tx.objectStore("chats").put({ bookId: keys.result[0], turns, updatedAt: Date.now() });
    };
    const settings = tx.objectStore("settings");
    const config = settings.get("reader");
    config.onsuccess = () => settings.put({ ...config.result, aiBaseUrl:"https://example.org/v1", aiModel:"fixture" }, "reader");
    await new Promise((resolve,reject) => { tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); });
    db.close();
  });
  await page.reload();
  await button("笔记").click();
  await button("AI 对话").click();
  const shelf = page.locator(".notes-book-row").first();
  const count = await shelf.locator("em").innerText();
  const measurement = await shelf.evaluate(async el => {
    const start = performance.now();
    el.click();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return { twoFramesMs: Math.round(performance.now()-start), mountedReplies: document.querySelectorAll(".ai-ask__turn-assistant").length };
  });
  console.log(JSON.stringify({ count, ...measurement }));
  assert.equal(count,"120 轮对话");
  assert.ok(measurement.mountedReplies > 0 && measurement.mountedReplies <= 8);
  const chat = page.getByRole("dialog",{name:"问 AI"});
  await chat.getByText("历史问题 120",{exact:true}).waitFor();
  await chat.getByRole("button",{ name:"查看更早的对话" }).click();
  assert.ok(await chat.locator(".ai-ask__turn-assistant").count() > measurement.mountedReplies);
  while (await chat.getByRole("button",{ name:"查看更早的对话" }).count()) {
    await chat.getByRole("button",{name:"查看更早的对话"}).click();
  }
  assert.equal(await chat.locator(".ai-ask__turn-assistant").count(),120);
  await chat.getByText("历史问题 1",{exact:true}).waitFor();
  await chat.getByRole("button",{name:"关闭",exact:true}).click();
  await shelf.click();
  assert.equal(await chat.locator(".ai-ask__turn-assistant").count(),measurement.mountedReplies);
  console.log("All older messages remain accessible and reopening resets the render window.");
} finally { await browser.close(); }
