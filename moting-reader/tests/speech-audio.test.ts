import assert from "node:assert/strict";
import test from "node:test";
import { fetchSpeechClip, parseSpeechClip, SpeechClipError } from "../lib/speech-audio.ts";

function framed(audio = new Uint8Array(144), timeline: unknown = [{ time: 0, charIndex: 0 }]): ArrayBuffer {
  const metadata = new TextEncoder().encode(JSON.stringify(timeline));
  const buffer = new ArrayBuffer(4 + metadata.length + audio.length);
  new DataView(buffer).setUint32(0, metadata.length);
  new Uint8Array(buffer, 4, metadata.length).set(metadata);
  new Uint8Array(buffer, 4 + metadata.length).set(audio);
  return buffer;
}

const frame = new Uint8Array(144);
frame.set([0xff, 0xf3, 0x64, 0xc4]);

test("空音频、无 MP3 帧或坏时间轴不能进播放器", () => {
  for (const body of [framed(new Uint8Array()), framed(), framed(frame, [{ time: null, charIndex: -1 }])]) {
    assert.throws(() => parseSpeechClip(body), SpeechClipError);
  }
  assert.equal(parseSpeechClip(framed(frame)).audio.size, frame.length);
});

test("收到响应头后正文断流也会超时，并取消下载", async () => {
  let cancelled = false;
  const fetcher: typeof fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([0, 0, 0, 2])); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(fetchSpeechClip("正文", "云健", undefined, { fetcher, timeoutMs: 20 }),
    (error: unknown) => error instanceof SpeechClipError && error.serviceDown);
  assert.equal(cancelled, true);
});

test("读取音频正文时用户取消能立即终止", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const fetcher: typeof fetch = async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }));
  const pending = fetchSpeechClip("正文", "云健", controller.signal, { fetcher, timeoutMs: 1000 });
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  assert.equal(cancelled, true);
});

test("云端 503 和文本 422 保持可重试分类，不返回系统音频", async () => {
  for (const status of [503, 422]) {
    const fetcher: typeof fetch = async () => Response.json({ error: "云端错误" }, { status });
    await assert.rejects(fetchSpeechClip("正文", "云健", undefined, { fetcher }),
      (error: unknown) => error instanceof SpeechClipError && error.message === "云端错误" &&
        error.serviceDown === (status === 503));
  }
});
