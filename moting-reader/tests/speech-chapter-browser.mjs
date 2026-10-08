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
const mp3 = makeAudio(6), native = makeAudio(90);
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
  const setup = async (hls = false, { failTts = 0 } = {}) => {
    const context = await browser.newContext({ userAgent: hls ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/26.6 Mobile/15E148 Safari/604.1" : undefined, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
    const page = await context.newPage();
    const errors = [], requests = [], sessions = [];
    let ready = false;
    page.on("pageerror", error => { if (errors.length < 10) errors.push(error.message); if (errors.length === 1) console.log("browser error:", error.stack); });
    await page.addInitScript((hls) => {
      // 可拨快的时钟：定时关闭按 Date.now() 判断到点。
      window.clockOffset = 0;
      const realNow = Date.now.bind(Date);
      Date.now = () => realNow() + window.clockOffset;
      // 假的系统朗读：记下念了什么，按字数估一个时长后结束。
      window.spoken = [];
      const synth = { speaking: false, paused: false, pending: false, current: null, timer: 0,
        getVoices: () => [{ voiceURI: "fake-zh", name: "Fake 中文", lang: "zh-CN", localService: true, default: true }],
        addEventListener() {}, removeEventListener() {},
        speak(utterance) { this.cancel(); this.current = utterance; this.speaking = true; window.spoken.push(utterance.text);
          this.timer = setTimeout(() => { this.speaking = false; this.current = null; utterance.onend?.(new Event("end")); }, 400 + utterance.text.length * 4); },
        cancel() { clearTimeout(this.timer); this.speaking = false; this.paused = false; this.current = null; },
        pause() { this.paused = true; }, resume() { this.paused = false; } };
      Object.defineProperty(window, "speechSynthesis", { configurable: true, value: synth });
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
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
      window.audioSeeks = []; const timeDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
      Object.defineProperty(HTMLMediaElement.prototype, "currentTime", { ...timeDescriptor, set(value) { window.audioSeeks.push(value); timeDescriptor.set.call(this,value); } });
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
      return route.fulfill({ json: { ready, complete: ready, duration: ready ? 90 : 0, updated: Date.now(), segments: ready ? [{ number: 0, start: 0, end: plan.length, duration: 90, time: 0, timeline: [] }] : [] } });
    });
    await page.route("**/__native.mp3", route => { const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? ""); const first = range ? Number(range[1]) : 0; const last = range?.[2] ? Math.min(Number(range[2]),native.length-1) : native.length-1; return route.fulfill({ status: range ? 206 : 200, contentType: "audio/mpeg", headers: { "accept-ranges":"bytes", ...(range ? { "content-range":`bytes ${first}-${last}/${native.length}` } : {}) }, body: native.subarray(first,last+1) }); });
    let failures = failTts;
    const ttsBodies = [];
    await page.route("**/api/tts", async route => {
      const body = route.request().postDataJSON(); requests.push(body.text); ttsBodies.push(body);
      if (failures > 0) { failures -= 1; await route.fulfill({ status: 503, json: { error: "朗读服务暂时不可用" } }); return; }
      const timeline = Array.from({ length: body.text.length + 1 }, (_, i) => ({ time: i * 6 / body.text.length, charIndex: i }));
      const meta = Buffer.from(JSON.stringify(timeline)); const length = Buffer.alloc(4); length.writeUInt32BE(meta.length);
      await new Promise(resolve => setTimeout(resolve, 60));
      await route.fulfill({ contentType: "application/octet-stream", body: Buffer.concat([length, meta, mp3]) });
    });
    await page.goto(`${base}/__speech-harness`);
    await page.waitForFunction(() => !!window.speechHarness, { timeout: 30000 });
    const start = () => page.evaluate(() => speechHarness.player.start(speechHarness.book.id, speechHarness.from));
    const countSources = () => page.evaluate(() => audioSources.filter(part => part.type !== "audio/wav").length);
    return { context, page, errors, requests, ttsBodies, sessions, start, countSources, allowReady: () => { ready = true; }, failTts: (count) => { failures = count; } };
  };

  const legacy = await setup();
  await legacy.start();
  await legacy.page.waitForFunction(() => speechHarness.player.location?.chapterIndex === 1, { timeout: 15000 });
  check("chapter_boundary_does_not_replace_the_audio_source", await legacy.countSources() === 1);
  check("short_opening_contains_tail_and_next_chapter", legacy.requests[0].includes("\n\n\n") && legacy.requests[0].length > 32);
  check("cloud_requests_use_structured_format", legacy.ttsBodies.every(body => body.format === 2));
  check("progress_keeps_chapter_local_sentence_indexes", await legacy.page.evaluate(() => speechHarness.history.some(pos => pos.chapterIndex === 0) && speechHarness.history.some(pos => pos.chapterIndex === 1 && pos.sentenceIndex === 0)));
  await legacy.page.waitForFunction(() => audioSources.filter(part => part.type !== "audio/wav").length >= 2, { timeout: 15000 });
  await legacy.page.waitForTimeout(200);
  check("continuation_uses_the_exact_prefetched_text", legacy.requests.length === 3 && new Set(legacy.requests).size === 3 && await legacy.countSources() === 2);
  // 系统打断（来电、拔耳机）只暂停元素：状态同步成暂停，再点继续接着放同一段。
  const legacySources = await legacy.countSources();
  await legacy.page.evaluate(() => audioElements[0].pause());
  await legacy.page.waitForFunction(() => !speechHarness.player.isPlaying && speechHarness.player.isPaused, { timeout: 3000 });
  check("legacy_system_pause_syncs_player_state", await legacy.page.evaluate(() => audioElements[0].paused));
  await legacy.page.evaluate(() => speechHarness.player.toggle());
  await legacy.page.waitForFunction(() => speechHarness.player.isPlaying && !audioElements[0].paused, { timeout: 3000 });
  check("legacy_resume_after_system_pause_keeps_the_source", await legacy.countSources() === legacySources);
  // 段内后退按真实时间轴跳，不重新合成、不换音源。夹具的音频只有 6 秒，按 3 秒跳。
  const requestsBeforeSkip = legacy.requests.length;
  await legacy.page.evaluate(() => { audioElements[0].currentTime = 5; });
  await legacy.page.evaluate(() => speechHarness.player.skipSeconds(-3));
  await legacy.page.waitForTimeout(300);
  check("legacy_skip_seconds_stays_in_the_loaded_clip", await legacy.countSources() === legacySources && legacy.requests.length === requestsBeforeSkip && await legacy.page.evaluate(() => audioElements[0].currentTime < 2.3));
  // 跳出这段音频：剩下的秒数按字数往前估，从那里重新起播。
  const before = await legacy.page.evaluate(() => ({ ...speechHarness.player.location }));
  await legacy.page.evaluate(() => { audioElements[0].currentTime = 0.5; });
  await legacy.page.evaluate(() => speechHarness.player.skipSeconds(-60));
  await legacy.page.waitForFunction((count) => audioSources.filter(part => part.type !== "audio/wav").length > count, legacySources, { timeout: 10000 });
  check("legacy_skip_past_the_clip_restarts_at_an_estimated_sentence", await legacy.page.evaluate((before) => {
    const at = speechHarness.player.location;
    return at && (at.chapterIndex < before.chapterIndex || (at.chapterIndex === before.chapterIndex && at.sentenceIndex < before.sentenceIndex)) && speechHarness.player.isPlaying;
  }, before));
  check("legacy_path_has_no_browser_errors", legacy.errors.length === 0);
  await legacy.context.close();

  const live = await setup(true);
  await live.start();
  await live.page.waitForTimeout(300);
  check("native_start_does_not_generate_a_competing_short_clip", live.requests.length === 0);
  live.allowReady();
  await live.page.waitForFunction(() => audioSources.some(part => part.src.includes("__native.mp3")), { timeout: 10000 });
  check("direct_play_prepares_and_promotes_native_audio", live.sessions.length === 1);
  check("live_session_uses_structured_text", live.sessions[0].format === 2 && live.sessions[0].text.includes("\n\n\n"));
  check("handover_reuses_the_user_activated_media_element", await live.page.evaluate(() => new Set(audioSources.map(part => part.id)).size === 1));
  await live.page.waitForFunction(() => speechHarness.player.location?.chapterIndex === 1, { timeout: 10000 });
  check("native_start_keeps_the_saved_chapter", await live.page.evaluate(() => speechHarness.player.location?.chapterIndex === 1));
  await live.page.waitForFunction(() => audioElements[0].readyState >= 2 && !audioElements[0].paused && audioElements[0].currentTime > 0, { timeout: 10000 });
  const beforeSkip = await live.countSources();
  await live.page.evaluate(() => speechHarness.player.changeChapter(1));
  await live.page.waitForFunction(() => speechHarness.player.location?.chapterIndex === 2, { timeout: 5000 });
  check("prepared_native_chapter_skip_seeks_without_restarting", await live.countSources() === beforeSkip && await live.page.evaluate(() => speechHarness.player.location?.chapterIndex === 2));
  const beforeSeconds = await live.page.evaluate(() => audioElements[0].currentTime);
  await live.page.evaluate(() => speechHarness.player.skipSeconds(15));
  await live.page.waitForTimeout(200);
  check("native_skip_seconds_seeks_forward_in_the_same_stream", await live.countSources() === beforeSkip && await live.page.evaluate((before) => audioElements[0].currentTime > before + 5, beforeSeconds));
  const beforeWaiting = await live.countSources();
  await live.page.evaluate(() => { const audio = audioElements[0]; const fixed = audio.currentTime; Object.defineProperty(audio, "currentTime", { configurable: true, get: () => fixed }); audio.dispatchEvent(new Event("waiting")); });
  await live.page.waitForTimeout(14500);
  check("fourteen_second_buffering_does_not_discard_the_native_stream", await live.countSources() === beforeWaiting && live.requests.length === 0);
  await live.page.evaluate(() => { delete audioElements[0].currentTime; });
  // Inject a transport error on the actual native media element, then check it does not reenter the broken stream.
  const beforeError = await live.countSources();
  await live.page.evaluate(() => audioElements[0].dispatchEvent(new Event("error")));
  await live.page.waitForFunction((count) => audioSources.filter(part => part.type !== "audio/wav").length > count, beforeError, { timeout: 10000 });
  await live.page.waitForTimeout(1200);
  check("native_transport_error_recovers_at_the_current_chapter", await live.page.evaluate(() => speechHarness.player.isPlaying && speechHarness.player.location?.chapterIndex === 2));
  check("transport_retry_reuses_the_same_native_session", live.sessions.length === 1 && live.requests.length === 0 && await live.page.evaluate(() => audioSources.filter(part => part.src.includes("__native.mp3")).length === 2));
  check("native_path_has_no_browser_errors", live.errors.length === 0);
  await live.context.close();

  const paused = await setup(true);
  await paused.start();
  await paused.page.waitForFunction(() => speechHarness.player.isBuffering, { timeout: 15000 });
  await paused.page.evaluate(() => speechHarness.player.toggle());
  const pausedSources = await paused.countSources();
  paused.allowReady();
  await paused.page.waitForTimeout(2200);
  check("late_native_readiness_does_not_resume_a_paused_player", await paused.countSources() === pausedSources && await paused.page.evaluate(() => !speechHarness.player.isPlaying));
  await paused.page.evaluate(() => speechHarness.player.toggle());
  await paused.page.waitForFunction(() => audioSources.some(part => part.src.includes("__native.mp3")), { timeout: 10000 });
  const userPausedSources = await paused.countSources();
  await paused.page.evaluate(() => speechHarness.player.toggle());
  await paused.page.waitForTimeout(3500);
  check("manual_pause_is_not_overridden_by_recovery", await paused.page.evaluate(() => !speechHarness.player.isPlaying && audioElements[0].paused) && await paused.countSources() === userPausedSources);
  await paused.page.evaluate(() => speechHarness.player.toggle());
  await paused.page.waitForFunction(() => !audioElements[0].paused, { timeout: 5000 });
  check("resume_can_promote_an_already_prepared_stream", await paused.page.evaluate(() => speechHarness.player.isPlaying));
  // 系统打断：同步成暂停、不自动续播（拔了耳机不该外放），锁屏的播放键按下去接着放同一路音频。
  await paused.page.evaluate(() => audioElements[0].pause());
  await paused.page.waitForTimeout(3500);
  check("unexpected_media_pause_syncs_to_paused_without_resuming", await paused.page.evaluate(() => !speechHarness.player.isPlaying && speechHarness.player.isPaused && audioElements[0].paused));
  await paused.page.evaluate(() => speechHarness.player.toggle());
  await paused.page.waitForFunction(() => !audioElements[0].paused, { timeout: 5000 });
  check("play_after_interruption_resumes_without_changing_the_source", await paused.countSources() === userPausedSources && await paused.page.evaluate(() => speechHarness.player.isPlaying));
  await paused.context.close();

  const sleep = await setup(true);
  await sleep.page.evaluate(() => speechHarness.player.setSleepMode("chapter"));
  await sleep.start(); sleep.allowReady();
  await sleep.page.waitForFunction(() => speechHarness.player.isPaused && !speechHarness.player.isPlaying, { timeout: 15000 });
  check("chapter_sleep_pauses_instead_of_stopping", await sleep.page.evaluate(() => speechHarness.player.location !== null && speechHarness.player.sleepMode === "off"));
  check("chapter_sleep_resumes_from_the_next_chapter", await sleep.page.evaluate(() => speechHarness.player.location?.chapterIndex === 1 && speechHarness.player.location?.sentenceIndex === 0));
  check("chapter_sleep_never_reads_into_the_next_chapter", await sleep.page.evaluate(() => speechHarness.history.every(pos => pos.chapterIndex === 0 || (pos.chapterIndex === 1 && pos.sentenceIndex === 0))));
  check("chapter_sleep_uses_the_continuous_stream", await sleep.page.evaluate(() => audioSources.some(part => part.src.includes("__native.mp3")) && audioElements[0].paused));
  await sleep.page.evaluate(() => speechHarness.player.toggle());
  await sleep.page.waitForFunction(() => speechHarness.player.isPlaying && !audioElements[0].paused, { timeout: 5000 });
  check("resume_after_chapter_sleep_continues_the_same_stream", await sleep.page.evaluate(() => audioSources.filter(part => part.src.includes("__native.mp3")).length === 1));
  await sleep.page.evaluate(() => speechHarness.player.setSleepMode("15"));
  check("timer_sleep_exposes_a_deadline", await sleep.page.evaluate(() => typeof speechHarness.player.sleepDeadline === "number" && speechHarness.player.sleepDeadline > Date.now()));
  await sleep.page.evaluate(() => { window.clockOffset = 16 * 60 * 1000; });
  await sleep.page.waitForFunction(() => speechHarness.player.isPaused && !speechHarness.player.isPlaying, { timeout: 5000 });
  check("timer_sleep_pauses_when_due", await sleep.page.evaluate(() => speechHarness.player.location !== null && speechHarness.player.sleepMode === "off" && speechHarness.player.sleepDeadline === null));
  check("sleep_path_has_no_browser_errors", sleep.errors.length === 0);
  await sleep.context.close();

  // 老路径（不支持原生 HLS）的「本章结束后」：同一段音频里停在换章前，挪到下一章开头。
  const legacySleep = await setup();
  await legacySleep.page.evaluate(() => speechHarness.player.setSleepMode("chapter"));
  await legacySleep.start();
  await legacySleep.page.waitForFunction(() => speechHarness.player.isPaused && !speechHarness.player.isPlaying, { timeout: 15000 });
  check("legacy_chapter_sleep_pauses_at_the_next_chapter", await legacySleep.page.evaluate(() => speechHarness.player.location?.chapterIndex === 1 && speechHarness.player.location?.sentenceIndex === 0));
  check("legacy_chapter_sleep_keeps_one_source", await legacySleep.countSources() === 1);
  check("legacy_sleep_path_has_no_browser_errors", legacySleep.errors.length === 0);
  await legacySleep.context.close();

  // 云端连不上：先等一下再试一次，再失败才用系统声音顶上；用户点继续时再给云端一次机会。
  const outage = await setup(false, { failTts: 2 });
  await outage.start();
  await outage.page.waitForFunction(() => window.spoken.length > 0, { timeout: 10000 });
  check("cloud_failure_is_retried_once_before_falling_back", outage.requests.length === 2);
  check("fallback_uses_the_system_voice_and_says_so", await outage.page.evaluate(() => speechHarness.player.isPlaying && /系统声音/.test(speechHarness.player.error)));
  await outage.page.waitForTimeout(1500);
  check("cooldown_keeps_the_system_voice_without_retrying_the_cloud", outage.requests.length === 2 && await outage.page.evaluate(() => !audioSources.some(part => part.type === "audio/mpeg")));
  // 冷却到点：系统朗读那边顺手试通云端，下一块自动换回云端声音，提示也撤掉。
  await outage.page.evaluate(() => { window.clockOffset = 31_000; });
  await outage.page.waitForFunction(() => audioSources.some(part => part.type === "audio/mpeg"), { timeout: 15000 });
  check("cloud_voice_comes_back_by_itself_after_cooldown", await outage.page.evaluate(() => speechHarness.player.isPlaying && speechHarness.player.error === ""));
  // 再断一次：这回用户自己点暂停、继续，直接再试云端。
  outage.failTts(2);
  await outage.page.evaluate(() => speechHarness.player.changeChapter(1));
  await outage.page.waitForFunction(() => /系统声音/.test(speechHarness.player.error), { timeout: 10000 });
  const cloudSources = await outage.page.evaluate(() => audioSources.filter(part => part.type === "audio/mpeg").length);
  await outage.page.evaluate(() => speechHarness.player.toggle());
  await outage.page.waitForFunction(() => speechHarness.player.isPaused, { timeout: 3000 });
  await outage.page.evaluate(() => speechHarness.player.toggle());
  await outage.page.waitForFunction((count) => audioSources.filter(part => part.type === "audio/mpeg").length > count, cloudSources, { timeout: 10000 });
  check("manual_resume_returns_to_the_cloud_voice", await outage.page.evaluate(() => speechHarness.player.isPlaying && speechHarness.player.error === ""));
  check("outage_path_has_no_browser_errors", outage.errors.length === 0);
  await outage.context.close();

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
