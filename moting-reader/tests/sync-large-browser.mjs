// 本地真 D1/R2 + 两个独立 IndexedDB 的恢复回归。禁止连接生产。
// MOTING_BROWSER_MODULES 可指定外部 Playwright 目录；MOTING_CHROMIUM_EXECUTABLE 可指定浏览器。
// MOTING_BROWSER_START_SERVER=1 会在同一进程环境启动隔离 Vite 服务。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const base = process.env.MOTING_TEST_URL ?? "http://127.0.0.1:5174";
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname), "only loopback test servers allowed");
const require = createRequire(process.env.MOTING_BROWSER_MODULES
  ? `${process.env.MOTING_BROWSER_MODULES}/package.json` : import.meta.url);
const { chromium } = require("playwright");
const checks = {};
const check = (name, value) => { assert.ok(value, name); checks[name] = true; };
const secrets = Object.fromEntries((await readFile(`${root}.dev.vars`, "utf8")).split("\n")
  .filter((line) => line.includes("=") && !line.startsWith("#")).map((line) => line.split(/=(.*)/s).slice(0, 2)));
let server;
let browser;
try {
  if (process.env.MOTING_BROWSER_START_SERVER === "1") {
    server = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", new URL(base).port],
      { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let logs = "";
    server.stdout.on("data", (chunk) => { logs += chunk; });
    server.stderr.on("data", (chunk) => { logs += chunk; });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { ready = (await fetch(`${base}/api/sync/session`)).ok; } catch { /* start-up */ }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error(`local server failed: ${logs.slice(-4000)}`);
  }
  browser = await chromium.launch({ headless: true,
    ...(process.env.MOTING_CHROMIUM_EXECUTABLE ? { executablePath: process.env.MOTING_CHROMIUM_EXECUTABLE } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const contextA = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const contextB = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const a = await contextA.newPage();
  const b = await contextB.newPage();
  const init = async (page) => {
    await page.goto(`${base}/manifest.webmanifest`);
    await page.evaluate(async (credentials) => {
      window.sync = await import("/lib/sync.ts");
      window.storage = await import("/lib/storage.ts");
      window.records = await import("/lib/sync-record.ts");
      await sync.loginSync(credentials.username, credentials.password, new AbortController().signal);
    }, { username: secrets.SYNC_USERNAME, password: secrets.SYNC_PASSWORD });
  };
  const run = (page, manual = false) => page.evaluate((manual) => sync.runSync({ signal: new AbortController().signal, manual }), manual);
  await init(a);
  const requestLog = [];
  a.on("request", (request) => {
    if (request.url().includes("/api/sync/")) requestLog.push({ path: new URL(request.url()).pathname,
      method: request.method(), bytes: request.postDataBuffer()?.byteLength ?? 0 });
  });
  const ids = await a.evaluate(async () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const now = Date.now() - 60000;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      await storage.saveBook({ id, title: `隔离同步验收 ${i}`, author: "测试", format: "txt", accent: "#8a8f98",
        status: "ready", createdAt: now, updatedAt: now, lastOpenedAt: now, sentenceCount: 1, characterCount: 6,
        chapters: [{ id: "c1", title: "第一章", order: 0, sentenceCount: 1, characterCount: 6,
          paragraphs: [{ id: "p1", order: 0, kind: "text", sentences: [{ id: "s1", order: 0, text: "隔离验收正文", speakableText: "隔离验收正文" }] }] }] });
      const target = i === 0 ? 7_390_299 : 2_355_294;
      const unit = "中文🌿\"\\\n";
      await storage.saveChat({ bookId: id, updatedAt: now,
        turns: [{ id: `u${i}`, role: "user", content: unit.repeat(Math.floor(target / 16)) },
          { id: `a${i}`, replyTo: `u${i}`, role: "assistant", content: "完整保留回答" }] });
    }
    await storage.saveSyncState({ schema: 4, pushedAt: Date.now(), pullCursor: 0,
      tombstones: { books: {}, notes: {} }, pendingContent: [], pendingImages: [], pendingPush: { chats: ids } });
    return ids;
  });
  const first = await run(a);
  check("legacy_failed_queue_recovers", first.failures.length === 0 && first.complete);
  const hashes = await a.evaluate(async () => Object.fromEntries((await storage.getAllChats())
    .map((chat) => [chat.bookId, JSON.stringify(chat.turns)])));
  const firstUploads = requestLog.filter((request) => request.method === "POST" && request.path.includes("/record/chats/"));
  check("two_large_bodies_uploaded", firstUploads.length === 2 && firstUploads.every((request) => request.bytes > 2_000_000));
  const before = requestLog.length;
  await run(a);
  check("unchanged_records_do_not_upload_again", !requestLog.slice(before).some((request) => request.method === "POST" && request.path.includes("/record/")));
  check("old_pending_queue_cleared", await a.evaluate(async () => !(await storage.getSyncState()).pendingPush.chats?.length));
  await init(b);
  await run(b);
  const remote = await b.evaluate(async () => Object.fromEntries((await storage.getAllChats())
    .map((chat) => [chat.bookId, JSON.stringify(chat.turns)])));
  check("second_device_receives_every_turn", ids.every((id) => remote[id] === hashes[id]));
  check("second_device_receives_books", await b.evaluate(async (ids) => {
    const metas = await storage.getBookMetas(); return ids.every((id) => metas.some((meta) => meta.id === id));
  }, ids));

  // 上传旧版本期间发生新修改，旧确认不能清掉新版本。
  await a.evaluate(async (id) => {
    const chat = (await storage.getAllChats()).find((chat) => chat.bookId === id);
    await storage.saveChat({ ...chat, updatedAt: Date.now(), turns: [...chat.turns, { id: "during-u", role: "user", content: "上传前的新提问" }] });
  }, ids[0]);
  let edited = false;
  await a.route("**/api/sync/record/chats/**", async (route) => {
    if (!edited && route.request().method() === "POST") {
      edited = true;
      await a.evaluate(async (id) => {
        const chat = (await storage.getAllChats()).find((chat) => chat.bookId === id);
        await storage.saveChat({ ...chat, updatedAt: Date.now() + 1,
          turns: [...chat.turns, { id: "during-a", replyTo: "during-u", role: "assistant", content: "上传期间的新回答" }] });
      }, ids[0]);
    }
    await route.continue();
  });
  const concurrent = await run(a);
  check("new_edit_survives_old_confirmation", edited && !concurrent.complete && concurrent.pendingRecords > 0);
  await a.unroute("**/api/sync/record/chats/**");
  await run(a);
  await run(b);
  check("new_edit_reaches_second_device", await b.evaluate(async (id) => (await storage.getAllChats())
    .find((chat) => chat.bookId === id).turns.some((turn) => turn.id === "during-a"), ids[0]));

  // 格式异常只拒收对应记录；自动重试不重复发，手动重试及修改后恢复。
  await a.evaluate(async (id) => {
    await storage.saveNote({ id: "invalid-future-note", bookId: id, text: "保留本地内容", thought: "原文保留",
      createdAt: Date.now(), updatedAt: Date.now() + 3 * 86400000, color: "pink" });
  }, ids[0]);
  const invalid = await run(a);
  check("invalid_record_has_reason_and_is_not_complete", invalid.failures.length === 1 && !invalid.complete && invalid.failures[0].reason.includes("时间"));
  const attempts = invalid.failures[0].attempts;
  await init(a);
  check("blocked_record_survives_reload", (await run(a)).failures[0].attempts === attempts);
  await a.goto(`${base}/`);
  await a.getByRole("button", { name: "设置", exact: true }).click();
  await a.locator(".settings-link").filter({ hasText: "云端同步" }).click();
  await a.getByText("1 条记录尚未同步，本机内容已保留", { exact: true }).waitFor();
  check("settings_shows_failed_record_details", (await a.locator(".settings-main").innerText()).includes("记录时间戳无效"));
  check("partial_sync_has_no_complete_message", !(await a.locator(".settings-main").innerText()).includes("全部同步完成"));
  await a.waitForFunction(() => ![...document.querySelectorAll("button")].some((button) => button.textContent === "同步中…"));
  await init(a);

  const held = await run(a);
  check("unchanged_invalid_record_is_held", held.failures[0].attempts === attempts);
  const manual = await run(a, true);
  check("manual_retry_is_available", manual.failures[0].attempts === attempts + 1);
  await a.evaluate(async (id) => {
    await storage.saveNote({ id: "invalid-future-note", bookId: id, text: "保留本地内容", thought: "修正后内容仍在",
      createdAt: Date.now(), updatedAt: Date.now(), color: "pink" });
  }, ids[0]);
  check("editing_a_held_record_recovers_it", (await run(a)).failures.length === 0);


  // 临时 R2 失败保留队列并退避，其他记录仍成功。
  await a.evaluate(async (id) => {
    const chat = (await storage.getAllChats()).find((chat) => chat.bookId === id);
    await storage.saveChat({ ...chat, updatedAt: Date.now(), turns: [...chat.turns, { id: "r2-outage", role: "user", content: "临时失败验收" }] });
    await storage.saveNote({ id: "small-during-outage", bookId: id, text: "小记录照常保存", thought: "保留",
      createdAt: Date.now(), updatedAt: Date.now(), color: "pink" });
  }, ids[0]);
  await a.route("**/api/sync/record/chats/**", async (route) => {
    if (route.request().method() === "POST") await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"隔离 R2 暂时失败"}' });
    else await route.continue();
  });
  const outage = await run(a);
  check("r2_outage_keeps_retry_queue", !outage.complete && outage.failures.length === 1 && outage.failures[0].retryable && outage.failures[0].retryAt > Date.now());
  check("automatic_retry_respects_backoff", (await run(a)).failures[0].attempts === outage.failures[0].attempts);
  await a.unroute("**/api/sync/record/chats/**");
  await a.evaluate(async () => { const state = await storage.getSyncState();
    await storage.saveSyncState({ ...state, pushFailures: state.pushFailures.map((failure) => ({ ...failure, retryAt: 0 })) }); });
  check("temporary_upload_failure_recovers", (await run(a)).failures.length === 0);
  await run(b);
  check("small_record_survives_large_record_outage", await b.evaluate(async () => (await storage.getAllNotes()).some((note) => note.id === "small-during-outage")));

  // 新增普通确认读取后，原有进度 mutation 仍按真实 D1 事务确认。
  await a.evaluate(async (id) => { const now = Date.now();
    await storage.saveReadingPositions([{ bookId: id, savedAt: now, lastOpenedAt: now,
      position: { chapterId: "c1", chapterIndex: 0, sentenceId: "s1", sentenceIndex: 0, percent: 1, updatedAt: now } }]);
    await sync.runProgressSync({ signal: new AbortController().signal });
  }, ids[0]);
  check("progress_receipt_still_clears_only_confirmed_mutation", await a.evaluate(async () => !(await storage.getProgressQueue()).some((entry) => entry.pending)));
  await b.evaluate(async () => sync.runProgressSync({ signal: new AbortController().signal }));
  check("progress_still_reaches_second_device", await b.evaluate(async (id) => (await storage.getAllBooks()).find((book) => book.id === id).readingPosition?.percent === 1, ids[0]));

  // 已上传正文的 R2/D1 之间中断，只补提交引用，不再传大正文。
  await a.evaluate(async (id) => {
    const chat = (await storage.getAllChats()).find((chat) => chat.bookId === id);
    await storage.saveChat({ ...chat, updatedAt: Date.now(), turns: [...chat.turns, { id: "lost-ack", role: "user", content: "确认丢失验收" }] });
  }, ids[1]);
  await a.route("**/api/sync/push", (route) => route.abort());
  let interrupted = false;
  try { await run(a); } catch { interrupted = true; }
  check("missing_d1_ack_is_not_success", interrupted);
  await a.unroute("**/api/sync/push");
  const retryStart = requestLog.length;
  await run(a);
  check("retry_reuses_uploaded_body", !requestLog.slice(retryStart).some((request) => request.method === "POST" && request.path.includes("/record/")));

  // 拉取正文损坏时不能越过记录；恢复后同一游标完整恢复。
  await b.evaluate(async () => { const state = await storage.getSyncState(); await storage.saveSyncState({ ...state, pullCursor: 0 }); });
  await b.route("**/api/sync/record/chats/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{\"damaged\":true}" }));
  let damaged = false;
  try { await run(b); } catch { damaged = true; }
  check("damaged_download_is_rejected", damaged);
  check("damaged_download_keeps_cursor", await b.evaluate(async () => (await storage.getSyncState()).pullCursor === 0));
  await b.unroute("**/api/sync/record/chats/**");
  await run(b);
  check("download_recovers_with_original_cursor", await b.evaluate(async () => (await storage.getSyncState()).pullCursor > 0));

  // 正文永久拒收也保留任务，自动重试暂停；手动恢复后才算全部完成。
  const blockedBook = await a.evaluate(async (id) => {
    const book = await storage.getBook(id);
    const key = crypto.randomUUID();
    const { syncReadyAt: _ready, ...rest } = book;
    await storage.saveBook({ ...rest, id: key, title: "正文拒收验收", updatedAt: Date.now() });
    return key;
  }, ids[0]);
  const blockedPath = `**/api/sync/book/${blockedBook}/content`;
  await a.route(blockedPath, async (route) => {
    if (route.request().method() === "POST") await route.fulfill({ status: 413, contentType: "application/json", body: '{"error":"正文超出同步上限"}' });
    else await route.continue();
  });
  const blocked = await run(a);
  check("rejected_book_body_remains_pending", !blocked.complete && blocked.blockedContent.some((entry) => entry.bookId === blockedBook));
  const bodyAttempts = () => requestLog.filter((request) => request.method === "POST" && request.path.includes(`/book/${blockedBook}/content`)).length;
  const attempted = bodyAttempts();
  await run(a);
  check("rejected_book_body_is_not_automatically_resent", bodyAttempts() === attempted);
  await a.unroute(blockedPath);
  const resumed = await run(a, true);
  check("manual_book_body_recovery_clears_block", resumed.complete && resumed.blockedContent.length === 0);

  await mkdir(`${root}outputs/sync-large`, { recursive: true });
  await writeFile(`${root}outputs/sync-large/validation.json`, JSON.stringify({ passed: true, checks,
    initial_upload_bytes: firstUploads.map((request) => request.bytes), production_data_written: false }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, initial_upload_bytes: firstUploads.map((request) => request.bytes) }));
} finally {
  await browser?.close();
  server?.kill("SIGTERM");
}
