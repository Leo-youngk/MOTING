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
  const run = (path: string, init?: RequestInit) => handleLiveHls(
    new Request(`https://test/api/sync/live/${path}`, init),
    bucket as unknown as R2Bucket, queue as unknown as Queue
  );
  return { bucket, queue, jobs, run };
}

test("independent Queue creates a growing EVENT playlist with valid packed MP3 and completed manifest", async () => {
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
  const clip = await run(`${session.id}/segment-0.mp3`, { headers: { range: "bytes=0-63" } });
  assert.equal(clip.status, 206);
  assert.equal((await clip.arrayBuffer()).byteLength, 64);
  assert.equal((await run(`${session.id}/segment-99.mp3`)).status, 404);
  while (jobs.length) await processLiveHlsJob(jobs.shift()!, bucket as unknown as R2Bucket, queue as unknown as Queue, synth);
  const after = await (await run(`${session.id}/playlist.m3u8`)).text();
  assert.match(after, /#EXT-X-ENDLIST/);
  const directory = mkdtempSync(join(tmpdir(), "moting-live-hls-"));
  try {
    const count = (after.match(/#EXTINF:/g) ?? []).length;
    for (let i = 0; i < count; i++) {
      writeFileSync(join(directory, `segment-${i}.mp3`), new Uint8Array(await (await run(`${session.id}/segment-${i}.mp3`)).arrayBuffer()));
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
  assert.equal((await run(`${session.id}/segment-0.mp3`)).status, 404);
});

test("already queued sessions retain five-segment numbering after the producer is upgraded", async () => {
  const { bucket, queue, jobs, run } = fixture();
  const session = await (await run("session", { method: "POST", body: JSON.stringify({ text: "兼容。".repeat(300), voice: "zh-CN-YunjianNeural" }) })).json() as { id: string };
  const key = `live-hls-v1/${session.id}/state.json`;
  const stored = JSON.parse(new TextDecoder().decode(bucket.objects.get(key)!));
  delete stored.groupSize; // The deployed v2 producer did not persist this field.
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

test("rollback rejects v4 media sessions without replacing their transport state", async () => {
  const { bucket, queue, jobs, run } = fixture();
  const { id } = await (await run("session", {
    method: "POST", body: JSON.stringify({ text: "格式兼容。".repeat(100), voice: "zh-CN-YunjianNeural" }),
  })).json() as { id: string };
  const key = `live-hls-v1/${id}/state.json`;
  const state = JSON.parse(new TextDecoder().decode(bucket.objects.get(key)!));
  const serialized = JSON.stringify({ ...state, format: 2, transport: "mpegts", parts: [] });
  await bucket.put(key, serialized);
  let synthesized = false;
  await processLiveHlsJob(jobs.shift()!, bucket as unknown as R2Bucket, queue as unknown as Queue, async () => {
    synthesized = true;
    return { audio, boundaries: [] };
  });
  assert.equal(synthesized, false);
  assert.equal(jobs.length, 0);
  assert.equal(new TextDecoder().decode(bucket.objects.get(key)!), serialized);
  for (const endpoint of ["status", "playlist.m3u8", "segment-0.mp3"]) {
    const response = await run(`${id}/${endpoint}`);
    assert.equal(response.status, 410);
    assert.match((await response.json() as { error: string }).error, /重新开始听书/);
  }
});

test("rollback retains bounded actual buffer and decoder error diagnostics", async () => {
  const { bucket, run } = fixture();
  const { id } = await (await run("session", {
    method: "POST", body: JSON.stringify({ text: "事件记录。", voice: "zh-CN-YunjianNeural" }),
  })).json() as { id: string };
  const response = await run(`${id}/event`, {
    method: "POST", body: JSON.stringify({
      type: "stalled", ct: 0, rs: 1, visibility: "visible", mediaError: 3,
      buffered: [[17.928, 31.152], ["invalid", 4], [2, 3], [4, 5], [6, 7]],
    }),
  });
  assert.equal(response.status, 200);
  const key = [...bucket.objects.keys()].find(name => name.startsWith(`live-hls-v1/${id}/events/`))!;
  const event = JSON.parse(new TextDecoder().decode(bucket.objects.get(key)!));
  assert.deepEqual(event.buffered, [[17.928, 31.152], [2, 3], [4, 5]]);
  assert.equal(event.mediaError, 3);
});
