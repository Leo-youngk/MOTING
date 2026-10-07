import assert from "node:assert/strict";
import test from "node:test";

import { HandshakeError, SynthesisTransportError } from "../worker/edge-tts.ts";
import { SpeechBatchError, synthesizeBatch } from "../worker/speech.ts";
import type { SpeechChunkResult } from "../lib/speech-batch.ts";

function fakeAudio(frameCount: number): Uint8Array {
  const audio = new Uint8Array(144 * frameCount);
  for (let index = 0; index < frameCount; index += 1) {
    audio.set([0xff, 0xf3, 0x64, 0xc4], index * 144);
  }
  return audio;
}

function spoken(text: string): SpeechChunkResult {
  return {
    audio: fakeAudio(60),
    boundaries: [{ offset: 0, duration: 5_000_000, text: text.slice(0, 1) }],
  };
}

function harness(script: Array<Error | "empty" | "ok"> = []) {
  const calls: string[] = [];
  const waits: number[] = [];
  const events: string[] = [];
  return {
    calls,
    waits,
    events,
    deps: {
      synthesize: async (text: string) => {
        calls.push(text);
        const next = script.shift() ?? "ok";
        if (next instanceof Error) throw next;
        if (next === "empty") return { audio: new Uint8Array(0), boundaries: [] };
        return spoken(text);
      },
      wait: async (ms: number) => {
        waits.push(Math.round(ms));
      },
      random: () => 0.5,
      log: (event: string) => {
        events.push(event);
      },
    },
  };
}

test("单片临时失败会换条连接重试，用户听不出来", async () => {
  const run = harness([new SynthesisTransportError("朗读服务提前关闭：1006")]);
  const result = await synthesizeBatch("那年冬天，雪下得特别早。", "zh-CN-YunjianNeural", new AbortController().signal, run.deps);

  assert.equal(run.calls.length, 2);
  assert.deepEqual(run.waits, [500]);
  assert.deepEqual(run.events, ["tts_chunk_retry"]);
  assert.ok(result.audio.length > 0);
});

test("握手一直被拒就报服务不可用（503），客户端据此暂时退回系统朗读", async () => {
  const run = harness([new HandshakeError(403), new HandshakeError(403), new HandshakeError(403)]);
  await assert.rejects(
    synthesizeBatch("那年冬天。", "zh-CN-YunjianNeural", new AbortController().signal, run.deps),
    (error: unknown) =>
      error instanceof SpeechBatchError && error.status === 503 && error.kind === "service"
  );
  assert.equal(run.calls.length, 3, "最多试三次");
  assert.deepEqual(run.waits, [500, 1000]);
});

test("全是符号的片不送去合成", async () => {
  const run = harness();
  await synthesizeBatch("上一段。\n\n＊　＊　＊\n\n下一段。", "zh-CN-YunjianNeural", new AbortController().signal, run.deps);
  assert.deepEqual(run.calls, ["上一段。", "下一段。"]);
});

test("一个字都读不出来报 422，不当成服务故障", async () => {
  const run = harness();
  await assert.rejects(
    synthesizeBatch("……——", "zh-CN-YunjianNeural", new AbortController().signal, run.deps),
    (error: unknown) => error instanceof SpeechBatchError && error.status === 422
  );
  assert.equal(run.calls.length, 0);
});

test("有字却没回音频的片再试一次，还是没有就跳过这片", async () => {
  const run = harness();
  run.deps.synthesize = async (text: string) => {
    run.calls.push(text);
    return text === "第一段。" ? { audio: new Uint8Array(0), boundaries: [] } : spoken(text);
  };
  const result = await synthesizeBatch(
    "第一段。\n\n第二段。",
    "zh-CN-YunjianNeural",
    new AbortController().signal,
    run.deps
  );
  assert.deepEqual(run.calls.sort(), ["第一段。", "第一段。", "第二段。"]);
  assert.deepEqual(result.timeline.map((entry) => entry.charIndex), [6]);
});

test("客户端走了就不再重试", async () => {
  const controller = new AbortController();
  const run = harness();
  run.deps.synthesize = async () => {
    controller.abort(new DOMException("gone", "AbortError"));
    throw new DOMException("gone", "AbortError");
  };
  await assert.rejects(
    synthesizeBatch("那年冬天。", "zh-CN-YunjianNeural", controller.signal, run.deps),
    (error: unknown) => error instanceof Error && error.name === "AbortError"
  );
  assert.equal(run.waits.length, 0);
});

test("控制字符在送去合成之前换成空格", async () => {
  const run = harness();
  await synthesizeBatch("第一行\u000b第二行。", "zh-CN-YunjianNeural", new AbortController().signal, run.deps);
  assert.deepEqual(run.calls, ["第一行 第二行。"]);
});
