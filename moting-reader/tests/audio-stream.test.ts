import test from "node:test";
import assert from "node:assert/strict";
import { handleAudioStream, streamChunks } from "../worker/audio-stream.ts";
import type { synthesizeSpeech } from "../worker/edge-tts.ts";
function bucketMock() {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    async put(key: string, value: string | Uint8Array) { data.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value); },
    async get(key: string) { const bytes = data.get(key); return bytes ? { body: bytes, arrayBuffer: async () => bytes.buffer, json: async () => JSON.parse(new TextDecoder().decode(bytes)) } : null; },
    async head(key: string) { return data.has(key) ? {} : null; },
  };
}
const request = (action: string, body?: unknown) => new Request(`https://test/api/sync/audio-stream/${action}`, body ? { method: "POST", body: JSON.stringify(body) } : {});

test("first sentence is short and subsequent chunks preserve text order", () => {
  const text = "开头。" + "后续文字😀。".repeat(100);
  const chunks = streamChunks(text);
  assert.ok(chunks[0].length <= 40);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every(c => c.length <= 600));
});

test("native response sends first bytes before synthesis completes; completed audio is reused", async () => {
  const bucket = bucketMock(); let calls = 0;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const synth: typeof synthesizeSpeech = async (_text, _voice, _signal, emit) => {
    calls++;
    await emit?.(new Uint8Array([1, 2]));
    await gate;
    await emit?.(new Uint8Array([3, 4]));
    return { audio: new Uint8Array([1, 2, 3, 4]), boundaries: [] };
  };
  const run = (r: Request) => handleAudioStream(r, bucket as unknown as R2Bucket, undefined, synth);
  const session = await (await run(request("session", { text: "第一句。", seconds: 600 }))).json() as { url: string };
  const response = await run(new Request(`https://test${session.url}`, { headers: { range: "bytes=0-1" } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), null);
  const reader = response.body!.getReader();
  assert.deepEqual((await reader.read()).value, new Uint8Array([1, 2]));
  finish();
  assert.deepEqual((await reader.read()).value, new Uint8Array([3, 4]));
  assert.equal((await reader.read()).done, true);
  assert.deepEqual(new Uint8Array(await (await run(new Request(`https://test${session.url}`))).arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
  assert.equal(calls, 1);
});

test("partial synthesis failure is never retried or cached", async () => {
  const bucket = bucketMock(); let calls = 0;
  const synth: typeof synthesizeSpeech = async (_text, _voice, _signal, emit) => {
    calls++; await emit?.(new Uint8Array([1])); throw new Error("upstream interrupted");
  };
  const run = (r: Request) => handleAudioStream(r, bucket as unknown as R2Bucket, undefined, synth);
  const session = await (await run(request("session", { text: "第一句。", seconds: 600 }))).json() as { url: string };
  const reader = (await run(new Request(`https://test${session.url}`))).body!.getReader();
  assert.deepEqual((await reader.read()).value, new Uint8Array([1]));
  await assert.rejects(reader.read(), /upstream interrupted/);
  assert.equal(calls, 1);
  assert.equal([...bucket.data.keys()].some(k => k.endsWith(".mp3")), false);
});

test("client cancellation aborts ongoing synthesis", async () => {
  const bucket = bucketMock(); let signal!: AbortSignal;
  const synth: typeof synthesizeSpeech = async (_text, _voice, input, emit) => {
    signal = input;
    await emit?.(new Uint8Array([1]));
    await new Promise<void>((_resolve, reject) => input.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    return { audio: new Uint8Array(), boundaries: [] };
  };
  const run = (r: Request) => handleAudioStream(r, bucket as unknown as R2Bucket, undefined, synth);
  const session = await (await run(request("session", { text: "第一句。", seconds: 600 }))).json() as { url: string };
  const reader = (await run(new Request(`https://test${session.url}`))).body!.getReader();
  await reader.read(); await reader.cancel();
  assert.equal(signal.aborted, true);
});
