import assert from "node:assert/strict";
import test from "node:test";

import { buildEdgeSpeechBatches, createChapter } from "../lib/content.ts";
import {
  QUICK_SPEECH_LENGTH,
  segmentFromChapter,
  sentenceAfter,
  spanForSentence,
  speechSegmentAt,
} from "../lib/speech-segments.ts";
import type { Chapter } from "../lib/types.ts";

function chapterOf(sentenceCount: number, length = 30): Chapter {
  const text = Array.from(
    { length: sentenceCount },
    (_, index) => `第${index}句${"墨".repeat(length)}。`
  ).join("");
  const chapter = createChapter("测试章", [{ text }], 0);
  assert.ok(chapter);
  return chapter;
}

test("从章节中间起播时裁掉前面并重算偏移", () => {
  const chapter = chapterOf(12);
  const segment = speechSegmentAt(buildEdgeSpeechBatches(chapter), 5);

  assert.ok(segment);
  assert.equal(segment.spans[0].sentenceIndex, 5, "第一个 span 就是要起播的那句");
  assert.equal(segment.spans[0].start, 0, "裁完偏移要从 0 重新起算");
  assert.ok(segment.text.startsWith("第5句"));
  for (const span of segment.spans) {
    assert.equal(segment.text.slice(span.start, span.end).length, span.end - span.start);
  }
});

test("短首段明显短于长批次，长批次覆盖的句子更多", () => {
  const chapter = chapterOf(80);
  const quick = segmentFromChapter(chapter, 0, "edge", true);
  const long = segmentFromChapter(chapter, 0, "edge", false);

  assert.ok(quick && long);
  assert.ok(quick.text.length <= QUICK_SPEECH_LENGTH);
  assert.ok(
    long.spans.length > quick.spans.length,
    "长批次要能一口气覆盖更多句子，否则后台连播又要频繁换源"
  );
});

test("短首段读完之后接的是紧挨着的下一句，不重不漏", () => {
  const chapter = chapterOf(80);
  const quick = segmentFromChapter(chapter, 0, "edge", true);
  assert.ok(quick);

  const next = sentenceAfter(quick);
  const continuation = segmentFromChapter(chapter, next, "edge", false);
  assert.ok(continuation);
  assert.equal(
    continuation.spans[0].sentenceIndex,
    next,
    "续播必须正好从首段结束的下一句开始"
  );
  assert.equal(
    quick.spans[quick.spans.length - 1].sentenceIndex + 1,
    continuation.spans[0].sentenceIndex
  );
});

test("超出章节范围返回 null，让调用方去翻下一章", () => {
  const chapter = chapterOf(6);
  assert.equal(speechSegmentAt(buildEdgeSpeechBatches(chapter), 999), null);
  assert.equal(speechSegmentAt([], 0), null);
});

test("交接时能在段内定位到指定句子", () => {
  const chapter = chapterOf(40);
  const segment = segmentFromChapter(chapter, 3, "edge", true);
  assert.ok(segment);

  const inside = segment.spans[2].sentenceIndex;
  const span = spanForSentence(segment, inside);
  assert.ok(span);
  assert.equal(span.sentenceIndex, inside);
  assert.equal(
    spanForSentence(segment, 9999),
    null,
    "段外的句子必须报 null，调用方才知道候选音频已经过期"
  );
});

test("系统朗读用的小块远小于云端长批次", () => {
  const chapter = chapterOf(80);
  const system = segmentFromChapter(chapter, 0, "system", false);
  const edge = segmentFromChapter(chapter, 0, "edge", false);

  assert.ok(system && edge);
  assert.ok(
    system.text.length < edge.text.length,
    "几千字塞不进 SpeechSynthesisUtterance"
  );
});
