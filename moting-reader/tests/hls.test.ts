import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packedAudio, handleHls } from "../worker/hls.ts";

test("packed audio ID3 carries a big endian 33-bit timestamp", () => {
  const bytes = packedAudio(new Uint8Array([1, 2, 3]), 121.056);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 3)), "ID3");
  assert.equal(new TextDecoder().decode(bytes.slice(10, 14)), "PRIV");
  const owner = new TextEncoder().encode("com.apple.streaming.transportStreamTimestamp\0");
  assert.deepEqual(bytes.slice(20, 20 + owner.length), owner);
  assert.equal(new DataView(bytes.buffer).getBigUint64(20 + owner.length), 10895040n);
  assert.deepEqual(bytes.slice(-3), new Uint8Array([1, 2, 3]));
});

// Real MP3 frames; generated fixture is transport test audio, not upstream TTS.
const audio = new Uint8Array(execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ar", "24000", "-ac", "1", "-b:a", "48k", "-f", "mp3", "pipe:1"]));
function memoryBucket() {
  const objects = new Map<string, { bytes: Uint8Array; customMetadata?: Record<string, string> }>();
  return {
    objects,
    async put(key: string, body: string | Uint8Array, options?: { customMetadata?: Record<string, string> }) { objects.set(key, { bytes: typeof body === "string" ? new TextEncoder().encode(body) : body, customMetadata: options?.customMetadata }); },
    async head(key: string) { const o = objects.get(key); return o ? { size: o.bytes.length, customMetadata: o.customMetadata } : null; },
    async get(key: string, options?: { range?: { offset: number; length: number } }) { const o = objects.get(key); if (!o) return null; const r = options?.range; return { body: r ? o.bytes.slice(r.offset, r.offset + r.length) : o.bytes }; },
    async list() { return { objects: [...objects.keys()].map(key => ({ key })) }; },
    async delete(keys: string[]) { keys.forEach(key => objects.delete(key)); },
  };
}

test("prepared VOD uses cached audio, exact byte ranges, valid decoder input and no synthesis during playback", async () => {
  const bucket = memoryBucket(); let calls = 0;
  const synth = async () => { calls++; return { audio }; };
  const request = (path: string, body?: unknown, headers?: HeadersInit) => new Request(`https://test/api/sync/hls/${path}`, body ? { method: "POST", body: JSON.stringify(body) } : { headers });
  const run = (req: Request) => handleHls(req, bucket as unknown as R2Bucket, synth);
  const clip = await (await run(request("prepare", { text: "测试。".repeat(80) }))).json() as { id: string; parts: { offset: number; length: number; duration: number }[] };
  assert.ok(clip.parts.length > 1);
  const generated = calls;
  await run(request("prepare", { text: "测试。".repeat(80) }));
  assert.equal(calls, generated);
  const finish = await (await run(request("finish", { ids: [clip.id, clip.id] }))).json() as { url: string };
  const playlist = await (await run(new Request(`https://test${finish.url}`))).text();
  assert.match(playlist, /#EXT-X-ENDLIST/);
  assert.equal(playlist.split("#EXT-X-DISCONTINUITY").length - 1, 1);
  const first = clip.parts[0];
  const segment = await run(request(`audio/${clip.id}.mp3`, undefined, { range: `bytes=${first.offset}-${first.offset + first.length - 1}` }));
  assert.equal(segment.status, 206);
  assert.equal(Number(segment.headers.get("content-length")), first.length);
  const bytes = new Uint8Array(await segment.arrayBuffer());
  assert.deepEqual(bytes, packedAudio(audio, 0));
  assert.equal(calls, generated);
  assert.equal((await run(request(`audio/${clip.id}.mp3`, undefined, { range: "bytes=99999999-" }))).status, 416);
  const dir = mkdtempSync(join(tmpdir(), "moting-hls-"));
  try {
    writeFileSync(join(dir, "segment.mp3"), bytes);
    execFileSync("ffmpeg", ["-v", "error", "-i", join(dir, "segment.mp3"), "-f", "null", "-"]);
    // Validate complete HLS demux including byte ranges and timestamp reset.
    const full = new Uint8Array(await (await run(request(`audio/${clip.id}.mp3`))).arrayBuffer());
    writeFileSync(join(dir, "clip.mp3"), full);
    writeFileSync(join(dir, "index.m3u8"), playlist.replaceAll(`audio/${clip.id}.mp3`, "clip.mp3"));
    execFileSync("ffmpeg", ["-v", "error", "-allowed_extensions", "ALL", "-i", join(dir, "index.m3u8"), "-f", "null", "-"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("invalid requests, unknown media and expired sessions fail without generation", async () => {
  const bucket = memoryBucket();
  const synth = async () => { throw new Error("must not synthesize"); };
  for (const [path, body] of [["prepare", { text: "x".repeat(601) }], ["finish", { ids: ["../book"] }]] as const) {
    const res = await handleHls(new Request(`https://test/api/sync/hls/${path}`, { method: "POST", body: JSON.stringify(body) }), bucket as unknown as R2Bucket, synth);
    assert.equal(res.status, 400);
  }
  const id = `${Date.now() - 172801_000}-${"a".repeat(64)}`;
  assert.equal((await handleHls(new Request(`https://test/api/sync/hls/${id}.m3u8`), bucket as unknown as R2Bucket, synth)).status, 404);
});
