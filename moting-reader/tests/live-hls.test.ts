import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLiveHls, processLiveHlsJob } from "../worker/live-hls.ts";

const audio = new Uint8Array(execFileSync("ffmpeg", [
  "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
  "-ar", "24000", "-ac", "1", "-b:a", "48k", "-f", "mp3", "pipe:1",
]));

function fixture() {
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    objects,
    async put(key: string, body: string | Uint8Array) {
      objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body);
    },
    async get(key: string, options?: { range?: { offset: number; length: number } }) {
      const bytes = objects.get(key); if (!bytes) return null;
      return {
        body: options?.range ? bytes.slice(options.range.offset, options.range.offset + options.range.length) : bytes,
        json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      };
    },
    async head(key: string) {
      const bytes = objects.get(key); return bytes ? { size: bytes.length } : null;
    },
  };
  const jobs: { id: string; group: number; target: number }[] = [];
  const queue = { async send(job: (typeof jobs)[number]) { jobs.push(job); } };
  const waits: Promise<unknown>[] = [];
  const run = (path: string, init?: RequestInit) => handleLiveHls(
    new Request(`https://test/api/sync/live/${path}`, init),
    bucket as unknown as R2Bucket, queue as unknown as Queue,
    { waitUntil(promise: Promise<unknown>) { waits.push(promise); } } as unknown as ExecutionContext
  );
  return { bucket, queue, jobs, run, waits };
}

test("independent Queue creates a growing EVENT playlist with valid MPEG-TS audio and completed manifest", async () => {
  const { bucket, queue, jobs, run } = fixture();
  const session = await (await run("session", {
    method: "POST", body: JSON.stringify({ text: "测试。" .repeat(250), voice: "zh-CN-YunjianNeural" }),
  })).json() as { id: string; url: string };
  assert.equal(jobs.length, 1);
  const synth = async () => ({ audio, boundaries: [] });
  await processLiveHlsJob(jobs.shift()!, bucket as unknown as R2Bucket, queue as unknown as Queue, synth);
  const before = await (await run(`${session.id}/playlist.m3u8`)).text();
  assert.match(before, /#EXT-X-PLAYLIST-TYPE:EVENT/);
  assert.doesNotMatch(before, /#EXT-X-ENDLIST/);
  const state = await (await run(`${session.id}/status`)).json() as { ready: boolean; segments: unknown[] };
  assert.equal(state.ready, false, "a short opening must not advertise an unsafe HLS buffer");
  assert.equal(state.segments.length, 2);
  const clip = await run(`${session.id}/segment-0.ts`, { headers: { range: "bytes=0-63" } });
  assert.equal(clip.status, 206);
  assert.equal((await clip.arrayBuffer()).byteLength, 64);
  assert.equal((await run(`${session.id}/segment-99.ts`)).status, 404);
  while (jobs.length) await processLiveHlsJob(jobs.shift()!, bucket as unknown as R2Bucket, queue as unknown as Queue, synth);
  const after = await (await run(`${session.id}/playlist.m3u8`)).text();
  assert.match(after, /#EXT-X-ENDLIST/);
  const directory = mkdtempSync(join(tmpdir(), "moting-live-hls-"));
  try {
    const count = (after.match(/#EXTINF:/g) ?? []).length;
    for (let i = 0; i < count; i++) {
      writeFileSync(join(directory, `segment-${i}.ts`), new Uint8Array(await (await run(`${session.id}/segment-${i}.ts`)).arrayBuffer()));
    }
    writeFileSync(join(directory, "playlist.m3u8"), after);
    execFileSync("ffmpeg", ["-v", "error", "-allowed_extensions", "ALL", "-i", join(directory, "playlist.m3u8"), "-f", "null", "-"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("unready and malformed sessions do not expose media or enqueue synthesis", async () => {
  const { jobs, run } = fixture();
  const bad = await run("session", { method: "POST", body: JSON.stringify({ text: "hi", voice: "../../secret" }) });
  assert.equal(bad.status, 400);
  assert.equal(jobs.length, 0);
  const session = await (await run("session", { method: "POST", body: JSON.stringify({ text: "文字".repeat(400), voice: "zh-CN-YunjianNeural" }) })).json() as { id: string };
  const status = await (await run(`${session.id}/status`)).json() as { ready: boolean };
  assert.equal(status.ready, false);
  assert.equal((await run(`${session.id}/segment-0.ts`)).status, 404);
});

test("already queued sessions retain five-segment numbering after the producer is upgraded", async () => {
  const { bucket, queue, jobs, run } = fixture();
  const session = await (await run("session", { method: "POST", body: JSON.stringify({ text: "兼容。".repeat(300), voice: "zh-CN-YunjianNeural" }) })).json() as { id: string };
  const key = `live-hls-v1/${session.id}/state.json`;
  const stored = JSON.parse(new TextDecoder().decode(bucket.objects.get(key)!));
  delete stored.groupSize; // The deployed v2 producer did not persist this field.
  delete stored.transport;
  delete stored.format;
  delete stored.parts;
  delete stored.target;
  await bucket.put(key, JSON.stringify(stored));
  const synth = async () => ({ audio, boundaries: [] });
  await processLiveHlsJob(jobs.shift()!, bucket as unknown as R2Bucket, queue as unknown as Queue, synth);
  const first = await (await run(`${session.id}/status`)).json() as { segments: { number: number }[] };
  assert.deepEqual(first.segments.map(part => part.number), [0, 1, 2, 3, 4]);
  while (jobs.length) await processLiveHlsJob(jobs.shift()!, bucket as unknown as R2Bucket, queue as unknown as Queue, synth);
  const last = await (await run(`${session.id}/status`)).json() as { complete: boolean; segments: { number: number }[] };
  assert.ok(last.complete);
  assert.deepEqual(last.segments.map(part => part.number), last.segments.map((_part, index) => index));
});

const longAudio = new Uint8Array(execFileSync("ffmpeg", [
  "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=21",
  "-ar", "24000", "-ac", "1", "-b:a", "48k", "-f", "mp3", "pipe:1",
]));

test("new native stream has six-second parts and continuous transport timestamps across Queue jobs", async () => {
  const { bucket, queue, jobs, run } = fixture();
  const { id } = await (await run("session", { method: "POST", body: JSON.stringify({ text: "连续听书。".repeat(90), voice: "zh-CN-YunjianNeural" }) })).json() as { id: string };
  const synth = async () => ({ audio: longAudio, boundaries: [] });
  while (jobs.length) await processLiveHlsJob(jobs.shift()!, bucket as unknown as R2Bucket, queue as unknown as Queue, synth);
  const playlist = await (await run(`${id}/playlist.m3u8?start=12`)).text();
  assert.match(playlist, /#EXT-X-TARGETDURATION:6/);
  assert.match(playlist, /#EXT-X-START:TIME-OFFSET=12.000000,PRECISE=YES/);
  assert.doesNotMatch(playlist, /#EXT-X-DISCONTINUITY/);
  const state = await (await run(`${id}/status`)).json() as { ready: boolean; parts: { number: number; time: number; duration: number }[] };
  assert.equal(state.ready, true);
  let end = 0;
  const directory = mkdtempSync(join(tmpdir(), "moting-continuous-hls-"));
  try {
    for (const part of state.parts) {
      assert.ok(part.duration <= 6 && part.duration > 0);
      assert.ok(Math.abs(part.time - end) < 1e-9);
      const response = await run(`${id}/segment-${part.number}.ts`);
      assert.match(response.headers.get("cache-control")!, /private.*immutable/);
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.equal(bytes.length % 188, 0);
      assert.equal(bytes[376], 0x47);
      const start = 376 + 5 + bytes[380] + 9;
      const pts = bytes.slice(start, start+5);
      const ticks = (BigInt((pts[0] >> 1) & 7) << 30n) | (BigInt(pts[1]) << 22n) | (BigInt(pts[2] >> 1) << 15n) | (BigInt(pts[3]) << 7n) | BigInt(pts[4] >> 1);
      assert.equal(ticks, BigInt(Math.round(part.time * 90_000)));
      end = part.time + part.duration;
      writeFileSync(join(directory, `segment-${part.number}.ts`), bytes);
    }
    writeFileSync(join(directory, "playlist.m3u8"), playlist);
    const result = execFileSync("ffmpeg", ["-v", "error", "-xerror", "-allowed_extensions", "ALL", "-i", join(directory, "playlist.m3u8"), "-f", "null", "-"]);
    assert.equal(result.length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("native media GET replenishes the background Queue and drops stale duplicate jobs", async () => {
  const { bucket, queue, jobs, run, waits } = fixture();
  const { id } = await (await run("session", { method: "POST", body: JSON.stringify({ text: "缓存连续听书。".repeat(1200), voice: "zh-CN-YunjianNeural" }) })).json() as { id: string };
  const synth = async () => ({ audio: longAudio, boundaries: [] });
  const first = jobs.shift()!;
  await processLiveHlsJob(first, bucket as unknown as R2Bucket, queue as unknown as Queue, synth);
  await run(`${id}/segment-0.ts`);
  await Promise.all(waits);
  assert.ok(jobs.some(job => job.target === 1200), "refill is triggered by native media requests without a JS heartbeat");
  while (jobs.length) await processLiveHlsJob(jobs.shift()!, bucket as unknown as R2Bucket, queue as unknown as Queue, synth);
  const state = await (await run(`${id}/status`)).json() as { duration: number };
  assert.ok(state.duration >= 1200);
  const size = jobs.length;
  await processLiveHlsJob({ ...first, target: 1200 }, bucket as unknown as R2Bucket, queue as unknown as Queue, synth);
  assert.equal(jobs.length, size, "the already satisfied target must not create another duplicate job");
});

test("failed R2 media publication cannot advertise missing segments or advance the source cursor", async () => {
  const { bucket, queue, jobs, run } = fixture();
  const { id } = await (await run("session", { method: "POST", body: JSON.stringify({ text: "音频不能丢。".repeat(90), voice: "zh-CN-YunjianNeural" }) })).json() as { id: string };
  const put = bucket.put.bind(bucket);
  bucket.put = async (key, body) => { if (key.endsWith("segment-2.ts")) throw new Error("R2 unavailable"); await put(key, body); };
  const synth = async () => ({ audio: longAudio, boundaries: [] });
  const job = jobs.shift()!;
  await assert.rejects(processLiveHlsJob(job, bucket as unknown as R2Bucket, queue as unknown as Queue, synth), /R2 unavailable/);
  const state = await (await run(`${id}/status`)).json() as { group: number; segments: unknown[]; parts: unknown[] };
  assert.equal(state.group, 0);
  assert.deepEqual(state.segments, []);
  assert.deepEqual(state.parts, []);
  bucket.put = put;
  await processLiveHlsJob(job, bucket as unknown as R2Bucket, queue as unknown as Queue, synth);
  assert.equal((await (await run(`${id}/status`)).json() as { group: number }).group, 1);
});
