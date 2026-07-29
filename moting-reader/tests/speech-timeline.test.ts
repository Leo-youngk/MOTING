import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBoundaryTimeline,
  charIndexAt,
  spanAt,
  TICKS_PER_SECOND,
} from "../lib/speech-timeline.ts";
import type { SpeechSpan } from "../lib/types.ts";

const seconds = (value: number) => value * TICKS_PER_SECOND;

test("按词序还原朗读时间轴的字符下标", () => {
  const text = "他抬头望向窗外，暮色漫过屋脊。";
  const timeline = buildBoundaryTimeline(text, [
    { offset: seconds(0.1), duration: seconds(0.15), text: "他" },
    { offset: seconds(0.25), duration: seconds(0.4), text: "抬头" },
    { offset: seconds(0.65), duration: seconds(0.2), text: "望" },
    { offset: seconds(0.85), duration: seconds(0.2), text: "向" },
    { offset: seconds(1.05), duration: seconds(0.5), text: "窗外" },
    { offset: seconds(1.85), duration: seconds(0.5), text: "暮色" },
  ]);

  assert.deepEqual(
    timeline.map((entry) => entry.charIndex),
    [0, 1, 3, 4, 5, 8]
  );
  assert.equal(timeline[1].time, 0.25);
});

test("重复词按词序推进而不是每次都匹配到第一个", () => {
  const text = "钟声一下，又一下。";
  const timeline = buildBoundaryTimeline(text, [
    { offset: 0, duration: seconds(0.4), text: "钟声" },
    { offset: seconds(0.4), duration: seconds(0.3), text: "一下" },
    { offset: seconds(0.8), duration: seconds(0.2), text: "又" },
    { offset: seconds(1), duration: seconds(0.3), text: "一下" },
  ]);

  assert.deepEqual(
    timeline.map((entry) => entry.charIndex),
    [0, 2, 5, 6]
  );
});

test("匹配不上的词退回游标以保持时间轴单调", () => {
  const text = "共有2026人到场。";
  const timeline = buildBoundaryTimeline(text, [
    { offset: 0, duration: seconds(0.3), text: "共有" },
    { offset: seconds(0.3), duration: seconds(0.9), text: "二零二六" },
    { offset: seconds(1.2), duration: seconds(0.3), text: "人" },
  ]);

  const indexes = timeline.map((entry) => entry.charIndex);
  assert.deepEqual(indexes, [0, 2, 6]);
  for (let i = 1; i < indexes.length; i++) {
    assert.ok(indexes[i] >= indexes[i - 1]);
  }
});

test("按播放秒数二分查到对应字符下标", () => {
  const timeline = [
    { time: 0, charIndex: 0 },
    { time: 0.5, charIndex: 4 },
    { time: 1.2, charIndex: 9 },
    { time: 2, charIndex: 15 },
  ];

  assert.equal(charIndexAt(timeline, 0), 0);
  assert.equal(charIndexAt(timeline, 0.4), 0);
  assert.equal(charIndexAt(timeline, 0.5), 4);
  assert.equal(charIndexAt(timeline, 1.9), 9);
  assert.equal(charIndexAt(timeline, 99), 15);
  assert.equal(charIndexAt([], 1), 0);
});

test("字符下标能定位到所属句子", () => {
  const spans: SpeechSpan[] = [
    { sentenceId: "a", sentenceIndex: 0, start: 0, end: 5 },
    { sentenceId: "b", sentenceIndex: 1, start: 5, end: 11 },
    { sentenceId: "c", sentenceIndex: 2, start: 11, end: 20 },
  ];

  assert.equal(spanAt(spans, 0).sentenceId, "a");
  assert.equal(spanAt(spans, 4).sentenceId, "a");
  assert.equal(spanAt(spans, 5).sentenceId, "b");
  assert.equal(spanAt(spans, 19).sentenceId, "c");
});
