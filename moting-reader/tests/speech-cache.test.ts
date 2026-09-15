import assert from "node:assert/strict";
import test from "node:test";

import { isAbortError, SpeechClipStore } from "../lib/speech-cache.ts";
import type { SpeechClip } from "../lib/speech-audio.ts";

function clip(bytes: number): SpeechClip {
  return {
    audio: new Blob([new Uint8Array(bytes)], { type: "audio/mpeg" }),
    timeline: [{ time: 0, charIndex: 0 }],
  };
}

/** 记下每次请求，并把 resolve 留在手上，好精确编排竞态。 */
function recorder(size = 8) {
  const calls: Array<{ text: string; voice: string; signal: AbortSignal }> = [];
  const settle: Array<(value: SpeechClip) => void> = [];
  const fail: Array<(reason: unknown) => void> = [];
  const fetcher = (text: string, voice: string, signal: AbortSignal) =>
    new Promise<SpeechClip>((resolve, reject) => {
      calls.push({ text, voice, signal });
      settle.push(resolve);
      fail.push(reject);
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  return { calls, settle, fail, fetcher, size };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("同一段文本只发一次请求，后来者共用结果", async () => {
  const fake = recorder();
  const store = new SpeechClipStore(fake.fetcher);

  const first = store.request("一段话", "晓晓", { priority: true });
  const second = store.request("一段话", "晓晓", { priority: true });
  await tick();

  assert.equal(fake.calls.length, 1);
  fake.settle[0](clip(64));
  assert.equal(await first, await second);
});

test("文本相同音色不同不能互相顶替", async () => {
  const fake = recorder();
  const store = new SpeechClipStore(fake.fetcher);

  store.request("一段话", "晓晓", { priority: true });
  store.request("一段话", "云希", { priority: true });
  await tick();

  assert.equal(fake.calls.length, 2);
  assert.deepEqual(
    fake.calls.map((call) => call.voice),
    ["晓晓", "云希"]
  );
});

test("命中缓存时同步返回，交接那一步不留 await", async () => {
  const fake = recorder();
  const store = new SpeechClipStore(fake.fetcher);

  const pending = store.request("一段话", "晓晓", { priority: true });
  await tick();
  fake.settle[0](clip(64));
  await pending;

  const ready = store.peek("一段话", "晓晓");
  assert.ok(ready, "缓存过的音频要能同步拿到");
  assert.equal(store.peek("没读过", "晓晓"), null);
  assert.deepEqual(store.stats().hits, 1);
  assert.deepEqual(store.stats().misses, 1);
});

test("所有消费者都撤了就把请求掐掉", async () => {
  const fake = recorder();
  const store = new SpeechClipStore(fake.fetcher);

  const controller = new AbortController();
  const request = store.request("一段话", "晓晓", {
    priority: false,
    signal: controller.signal,
  });
  await tick();
  assert.equal(fake.calls[0].signal.aborted, false);

  controller.abort();
  await assert.rejects(request, (reason: unknown) => isAbortError(reason));
  assert.equal(fake.calls[0].signal.aborted, true, "没人等了就该断掉上游请求");
});

test("预取排队，正在播放的请求不排队", async () => {
  const fake = recorder();
  const store = new SpeechClipStore(fake.fetcher, 1024 * 1024, 2);

  store.prefetch("甲", "晓晓");
  store.prefetch("乙", "晓晓");
  store.prefetch("丙", "晓晓");
  await tick();
  assert.deepEqual(
    fake.calls.map((call) => call.text),
    ["甲", "乙"],
    "并发上限是 2，第三条要等"
  );

  store.request("丁", "晓晓", { priority: true });
  await tick();
  assert.ok(
    fake.calls.some((call) => call.text === "丁"),
    "正在播放要用的那条必须插队发出去"
  );

  fake.settle[0](clip(16));
  await tick();
  assert.ok(
    fake.calls.some((call) => call.text === "丙"),
    "腾出名额后排队的预取要接上"
  );
});

test("排队中的预取被真正要播时立刻发出去", async () => {
  const fake = recorder();
  const store = new SpeechClipStore(fake.fetcher, 1024 * 1024, 1);

  store.prefetch("甲", "晓晓");
  store.prefetch("乙", "晓晓");
  await tick();
  assert.deepEqual(fake.calls.map((call) => call.text), ["甲"]);

  store.request("乙", "晓晓", { priority: true });
  await tick();
  assert.deepEqual(fake.calls.map((call) => call.text), ["甲", "乙"]);
});

test("超出预算按最久未用淘汰", async () => {
  const fake = recorder();
  const store = new SpeechClipStore(fake.fetcher, 100);

  for (const [index, text] of ["甲", "乙", "丙"].entries()) {
    const pending = store.request(text, "晓晓", { priority: true });
    await tick();
    fake.settle[index](clip(40));
    await pending;
  }

  assert.equal(store.has("甲", "晓晓"), false, "最久没用的那条该被挤掉");
  assert.equal(store.has("乙", "晓晓"), true);
  assert.equal(store.has("丙", "晓晓"), true);
  assert.ok(store.stats().bytes <= 100);
});

test("单段就超预算的不进缓存，免得把别人全挤走", async () => {
  const fake = recorder();
  const store = new SpeechClipStore(fake.fetcher, 100);

  const small = store.request("小", "晓晓", { priority: true });
  await tick();
  fake.settle[0](clip(40));
  await small;

  const huge = store.request("大", "晓晓", { priority: true });
  await tick();
  fake.settle[1](clip(400));
  await huge;

  assert.equal(store.has("大", "晓晓"), false);
  assert.equal(store.has("小", "晓晓"), true);
});

test("cancelPending 掐掉预取但不动正在播放的请求", async () => {
  const fake = recorder();
  const store = new SpeechClipStore(fake.fetcher, 1024 * 1024, 4);

  store.request("正在播", "晓晓", { priority: true });
  store.prefetch("备选", "云希");
  await tick();

  store.cancelPending();
  await tick();

  const playing = fake.calls.find((call) => call.text === "正在播");
  const spare = fake.calls.find((call) => call.text === "备选");
  assert.equal(playing?.signal.aborted, false);
  assert.equal(spare?.signal.aborted, true);
});

test("连点换音色时，被顶掉的那几条准备任务会真的断掉", async () => {
  const fake = recorder();
  const store = new SpeechClipStore(fake.fetcher, 1024 * 1024, 4);

  // 每次换音色都是一条 priority 请求，带自己的 signal。
  const controllers = ["甲", "乙", "丙"].map(() => new AbortController());
  const requests = ["甲", "乙", "丙"].map((voice, index) =>
    store
      .request("同一段文本", voice, {
        priority: true,
        signal: controllers[index].signal,
      })
      .catch(() => "cancelled")
  );
  await tick();
  assert.equal(fake.calls.length, 3);

  // 用户又点了两下，前两次作废。
  controllers[0].abort();
  controllers[1].abort();
  await tick();

  assert.equal(await requests[0], "cancelled");
  assert.equal(await requests[1], "cancelled");
  assert.deepEqual(
    fake.calls.map((call) => call.signal.aborted),
    [true, true, false],
    "只有最后一次选择该继续跑"
  );
});

test("还有人等的时候不会被别人的取消带走", async () => {
  const fake = recorder();
  const store = new SpeechClipStore(fake.fetcher);

  const abandoned = new AbortController();
  const dropped = store
    .request("一段话", "晓晓", { priority: true, signal: abandoned.signal })
    .catch(() => "cancelled");
  const kept = store.request("一段话", "晓晓", { priority: true });
  await tick();

  abandoned.abort();
  await tick();
  assert.equal(await dropped, "cancelled");
  assert.equal(fake.calls[0].signal.aborted, false);

  fake.settle[0](clip(32));
  assert.ok(await kept);
});
