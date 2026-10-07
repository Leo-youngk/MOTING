// Real public-domain text + actual Chromium MP3 decoding. HLS control flow is
// exercised with an MP3 stand-in: this does not claim to emulate iPhone WebKit.
// READER_BOOK_PATH=/tmp/moting-real-book-25328.txt MOTING_BROWSER_MODULES=... \
// MOTING_CHROMIUM_EXECUTABLE=... MOTING_BROWSER_START_SERVER=1 node tests/speech-chapter-browser.mjs
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const base = process.env.MOTING_TEST_URL ?? "http://127.0.0.1:5176";
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname), "loopback only");
const bookPath = process.env.READER_BOOK_PATH;
assert.ok(bookPath, "READER_BOOK_PATH must contain the actual Gutenberg #25328 text");
const text = await readFile(bookPath, "utf8");
const require = createRequire(process.env.MOTING_BROWSER_MODULES ? `${process.env.MOTING_BROWSER_MODULES}/package.json` : import.meta.url);
const { chromium } = require("playwright");
const makeAudio = (duration) => execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `sine=frequency=440:duration=${duration}`, "-ar", "24000", "-ac", "1", "-b:a", "48k", "-f", "mp3", "pipe:1"]);
const mp3 = makeAudio(6), native = makeAudio(20);
const checks = {};
const check = (name, value) => { assert.ok(value, name); checks[name] = true; };
let server, browser;
try {
  if (process.env.MOTING_BROWSER_START_SERVER === "1") {
    server = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", new URL(base).port, "--strictPort"], { cwd: root, env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let logs = "";
    server.stdout.on("data", data => { logs += data; }); server.stderr.on("data", data => { logs += data; });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { ready = (await fetch(`${base}/manifest.webmanifest`)).ok; } catch { /* startup */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(ready, logs.slice(-3000));
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.MOTING_CHROMIUM_EXECUTABLE, args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"] });
  const setup = async (hls = false) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
    const page = await context.newPage();
    const errors = [], requests = [], sessions = [];
    let ready = false;
    page.on("pageerror", error => { if (errors.length < 10) errors.push(error.message); if (errors.length === 1) console.log("browser error:", error.stack); });
    await page.addInitScript((hls) => {
      window.audioSources = [];
      window.audioElements = [];
      const blobTypes = new Map();
      const createUrl = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { const url = createUrl(blob); blobTypes.set(url, blob.type); return url; };
      const ids = new WeakMap(); let next = 0;
      const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
      Object.defineProperty(HTMLMediaElement.prototype, "src", { ...descriptor, set(value) {
        if (!ids.has(this)) { ids.set(this, ++next); window.audioElements.push(this); }
        window.audioSources.push({ id: ids.get(this), src: value, type: blobTypes.get(value) ?? "native" });
        descriptor.set.call(this, value);
      } });
      const original = HTMLMediaElement.prototype.canPlayType;
      HTMLMediaElement.prototype.canPlayType = function(type) { return type === "application/vnd.apple.mpegurl" ? (hls ? "maybe" : "") : original.call(this, type); };
    }, hls);
    await page.route("**/__speech-harness", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true; await import("/@vite/client"); await import("/tests/speech-player-harness.tsx");</script>' }));
    // No HMR websocket is needed by this isolated fixture; keep application module errors visible.
    await page.route("**/@vite/client", route => route.fulfill({ contentType: "text/javascript", body: 'export const createHotContext=()=>({data:{},accept(){},dispose(){},prune(){},invalidate(){},send(){},on(){},off(){}}); export const injectQuery=(url)=>url; export const updateStyle=()=>{}; export const removeStyle=()=>{};' }));
    await page.route("**/__realbook.txt", route => route.fulfill({ contentType: "text/plain; charset=utf-8", body: text }));
    await page.route("**/api/sync/live/client", route => route.fulfill({ json: { ok: true } }));
    await page.route("**/api/sync/live/*/event", route => route.fulfill({ json: { ok: true } }));
    await page.route("**/api/sync/live/session", async route => {
      const body = route.request().postDataJSON(); sessions.push(body);
      await route.fulfill({ json: { id: `fixture-${sessions.length}`, url: `${base}/__native.mp3` } });
    });
    await page.route("**/api/sync/live/*/status", route => {
      const plan = sessions.at(-1)?.text ?? "";
      return route.fulfill({ json: { ready, complete: ready, duration: ready ? 20 : 0, updated: Date.now(), segments: ready ? [{ number: 0, start: 0, end: plan.length, duration: 20, time: 0, timeline: [] }] : [] } });
    });
    await page.route("**/__native.mp3", route => route.fulfill({ contentType: "audio/mpeg", body: native }));
    await page.route("**/api/tts", async route => {
      const body = route.request().postDataJSON(); requests.push(body.text);
      const timeline = Array.from({ length: body.text.length + 1 }, (_, i) => ({ time: i * 6 / body.text.length, charIndex: i }));
      const meta = Buffer.from(JSON.stringify(timeline)); const length = Buffer.alloc(4); length.writeUInt32BE(meta.length);
      await new Promise(resolve => setTimeout(resolve, 60));
      await route.fulfill({ contentType: "application/octet-stream", body: Buffer.concat([length, meta, mp3]) });
    });
    await page.goto(`${base}/__speech-harness`);
    await page.waitForFunction(() => !!window.speechHarness, { timeout: 30000 });
    const start = () => page.evaluate(() => speechHarness.player.start(speechHarness.book.id, speechHarness.from));
    const countSources = () => page.evaluate(() => audioSources.filter(part => part.type !== "audio/wav").length);
    return { context, page, errors, requests, sessions, start, countSources, allowReady: () => { ready = true; } };
  };

  const legacy = await setup();
  await legacy.start();
  await legacy.page.waitForFunction(() => speechHarness.player.location?.chapterIndex === 1, { timeout: 15000 });
  check("chapter_boundary_does_not_replace_the_audio_source", await legacy.countSources() === 1);
  check("short_opening_contains_tail_and_next_chapter", legacy.requests[0].includes("\n") && legacy.requests[0].length > 32);
  check("progress_keeps_chapter_local_sentence_indexes", await legacy.page.evaluate(() => speechHarness.history.some(pos => pos.chapterIndex === 0) && speechHarness.history.some(pos => pos.chapterIndex === 1 && pos.sentenceIndex === 0)));
  await legacy.page.waitForFunction(() => audioSources.filter(part => part.type !== "audio/wav").length >= 2, { timeout: 15000 });
  await legacy.page.waitForTimeout(200);
  check("continuation_uses_the_exact_prefetched_text", legacy.requests.length === 3 && new Set(legacy.requests).size === 3 && await legacy.countSources() === 2);
  check("legacy_path_has_no_browser_errors", legacy.errors.length === 0);
  await legacy.context.close();

  const live = await setup(true);
  await live.start();
  await live.page.waitForFunction(() => speechHarness.player.location?.chapterIndex === 1, { timeout: 15000 });
  live.allowReady();
  await live.page.waitForFunction(() => audioSources.some(part => part.src.includes("__native.mp3")), { timeout: 10000 });
  check("direct_play_prepares_and_promotes_native_audio", live.sessions.length === 1);
  check("handover_reuses_the_user_activated_media_element", await live.page.evaluate(() => new Set(audioSources.map(part => part.id)).size === 1));
  check("handover_keeps_the_current_chapter", await live.page.evaluate(() => speechHarness.player.location?.chapterIndex === 1));
  const beforeSkip = await live.countSources();
  await live.page.evaluate(() => speechHarness.player.changeChapter(1));
  check("prepared_native_chapter_skip_seeks_without_restarting", await live.countSources() === beforeSkip && await live.page.evaluate(() => speechHarness.player.location?.chapterIndex === 2));
  // Inject a transport error on the actual native media element, then check it does not reenter the broken stream.
  const beforeError = await live.countSources();
  await live.page.evaluate(() => audioElements[0].dispatchEvent(new Event("error")));
  await live.page.waitForFunction((count) => audioSources.filter(part => part.type !== "audio/wav").length > count, beforeError, { timeout: 10000 });
  await live.page.waitForTimeout(1200);
  check("native_transport_error_recovers_at_the_current_chapter", await live.page.evaluate(() => speechHarness.player.isPlaying && speechHarness.player.location?.chapterIndex === 2));
  check("failed_native_stream_is_not_promoted_again", await live.page.evaluate(() => audioSources.filter(part => part.src.includes("__native.mp3")).length === 1));
  check("native_path_has_no_browser_errors", live.errors.length === 0);
  await live.context.close();

  const paused = await setup(true);
  await paused.start();
  await paused.page.waitForFunction(() => speechHarness.player.location?.chapterIndex === 1, { timeout: 15000 });
  await paused.page.evaluate(() => speechHarness.player.toggle());
  const pausedSources = await paused.countSources();
  paused.allowReady();
  await paused.page.waitForTimeout(2200);
  check("late_native_readiness_does_not_resume_a_paused_player", await paused.countSources() === pausedSources && await paused.page.evaluate(() => !speechHarness.player.isPlaying));
  await paused.page.evaluate(() => speechHarness.player.toggle());
  await paused.page.waitForFunction(() => audioSources.some(part => part.src.includes("__native.mp3")), { timeout: 10000 });
  check("resume_can_promote_an_already_prepared_stream", await paused.page.evaluate(() => speechHarness.player.isPlaying));
  await paused.context.close();

  const sleep = await setup(true);
  await sleep.page.evaluate(() => speechHarness.player.setSleepMode("chapter"));
  await sleep.start(); sleep.allowReady();
  await sleep.page.waitForFunction(() => speechHarness.player.location === null, { timeout: 15000 });
  check("chapter_sleep_stops_at_the_selected_chapter", await sleep.page.evaluate(() => speechHarness.history.every(pos => pos.chapterIndex === 0)));
  check("chapter_sleep_does_not_promote_to_a_cross_chapter_stream", await sleep.page.evaluate(() => !audioSources.some(part => part.src.includes("__native.mp3"))));
  check("sleep_path_has_no_browser_errors", sleep.errors.length === 0);
  await sleep.context.close();

  const report = { passed: true, checks, realBook: "豆棚閒話 · Gutenberg #25328", transport: "actual Chromium MP3 playback; native HLS control flow uses MP3 stand-in", production_data_written: false };
  await mkdir(`${root}outputs/speech-chapter`, { recursive: true });
  await writeFile(`${root}outputs/speech-chapter/validation.json`, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  if (server) {
    try { process.kill(-server.pid, "SIGTERM"); } catch { /* already exited */ }
    server.stdout.destroy(); server.stderr.destroy(); server.unref();
  }
}
