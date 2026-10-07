// Real HTTP .m3u8 decoding of the production packager, with a complete public-domain
// book as the source. The synthesizer uses valid MP3 tones; it does not test voice quality
// or emulate an iPhone's OS lock screen. All requests and objects remain on loopback.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createBook, createChapter, positionFor } from "../lib/content.ts";
import { makeLivePlan } from "../lib/live-speech.ts";
import { handleLiveHls, processLiveHlsJob } from "../worker/live-hls.ts";

const text = (await readFile(process.env.READER_BOOK_PATH, "utf8")).split("*** END OF")[0];
const sections = text.split(/^第[一二三四五六七八九十]+則[^\n]*\n/m).slice(1);
assert.ok(sections.length >= 11, "use the complete public-domain 豆棚閒話");
const book = createBook({ title: "豆棚閒話", format: "txt", chapters: sections.map((body, index) => createChapter(`第${index + 1}則`, [{ text: body }], index)) });
const plan = makeLivePlan(book, positionFor(book, 0, 0));
assert.equal(plan.sentences.at(-1).chapterIndex, book.chapters.length - 1);
const audio = new Uint8Array(execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=21", "-ar", "24000", "-ac", "1", "-b:a", "48k", "-f", "mp3", "pipe:1"]));
const objects = new Map();
const bucket = {
  async put(key, body) { objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body); },
  async head(key) { const bytes = objects.get(key); return bytes ? { size: bytes.length } : null; },
  async get(key, options) {
    const bytes = objects.get(key); if (!bytes) return null;
    return { body: options?.range ? bytes.slice(options.range.offset, options.range.offset + options.range.length) : bytes,
      json: async () => JSON.parse(new TextDecoder().decode(bytes)) };
  },
};
const jobs = [], requests = [];
let running = false, closing = false, workerError;
const synth = async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { audio, boundaries: [] }; };
const queue = { async send(job) { jobs.push(job); void pump(); } };
async function pump() {
  if (running || closing) return;
  running = true;
  try { while (jobs.length && !closing) await processLiveHlsJob(jobs.shift(), bucket, queue, synth); }
  catch (error) { workerError = error; }
  finally { running = false; }
}
const waits = [];
const ctx = { waitUntil(promise) { waits.push(promise); } };
const { id } = await (await handleLiveHls(new Request("http://localhost/api/sync/live/session", {
  method: "POST", body: JSON.stringify({ text: plan.text, voice: "zh-CN-YunjianNeural" }),
}), bucket, queue, ctx)).json();
while (true) {
  if (workerError) throw workerError;
  const status = await (await handleLiveHls(new Request(`http://localhost/api/sync/live/${id}/status`), bucket, queue, ctx)).json();
  if (status.ready) break;
  await new Promise(resolve => setTimeout(resolve, 25));
}
const server = createServer(async (req, res) => {
  try {
    requests.push(req.url);
    const response = await handleLiveHls(new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers }), bucket, queue, ctx);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let decoder;
try {
  const output = [], errors = [];
  decoder = spawn("ffmpeg", ["-v", "error", "-xerror", "-readrate", "8", "-live_start_index", "0", "-prefer_x_start", "1", "-allowed_extensions", "ALL", "-i", `${base}/api/sync/live/${id}/playlist.m3u8?start=0`, "-t", "360", "-progress", "pipe:1", "-f", "null", "-"]);
  decoder.stdout.on("data", chunk => output.push(chunk.toString()));
  decoder.stderr.on("data", chunk => errors.push(chunk.toString()));
  const code = await new Promise((resolve, reject) => { decoder.on("exit", resolve); decoder.on("error", reject); });
  assert.equal(code, 0, errors.join(""));
  assert.equal(errors.join(""), "", "decoder must report no invalid frames or non-monotonic timestamps");
  const playedSeconds = Math.max(...[...output.join("").matchAll(/out_time_us=(\d+)/g)].map(match => Number(match[1])/1e6));
  assert.ok(playedSeconds >= 359.9, JSON.stringify({ playedSeconds, lastProgress: output.join("").slice(-400) }));
  const fetchedParts = requests.filter(url => /segment-\d+\.ts/.test(url));
  assert.ok(fetchedParts.length >= 60, "decode successive HLS resources rather than one MP3 stand-in");
  await Promise.all(waits);
  const state = await bucket.get(`live-hls-v1/${id}/state.json`).then(item => item.json());
  assert.ok(state.duration >= 1200, "media GETs keep the independent producer ahead without page JavaScript");
  const report = { passed: true, publicBook: book.title, chapters: book.chapters.length,
    characters: plan.text.length, decodedSeconds: playedSeconds, mediaRequests: fetchedParts.length,
    preparedSeconds: state.duration, decoderErrors: errors,
    transport: "FFmpeg real HTTP HLS decoder at 8x; production packager; controlled MP3 synthesizer", physicalIPhoneTested: false };
  await mkdir("outputs/hls-transport", { recursive: true });
  await writeFile("outputs/hls-transport/validation.json", JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report,null,2));
} finally {
  closing = true;
  decoder?.kill("SIGTERM");
  await new Promise(resolve => server.close(resolve));
}
