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
  assert.equal(state.segments.length, 5);
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
