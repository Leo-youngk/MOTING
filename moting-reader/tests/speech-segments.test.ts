import assert from "node:assert/strict";
import test from "node:test";

import { buildEdgeSpeechBatches, createChapter } from "../lib/content.ts";
import {
  QUICK_SPEECH_LENGTH,
  segmentFromChapter,
  sentenceAfter,
  spanForSentence,
  speechSegmentAt,
  segmentFromBook,
  spanForBookSentence,
  nextBookSentence,
} from "../lib/speech-segments.ts";
import type { Book, Chapter } from "../lib/types.ts";

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

test("a short chapter tail and the next chapter share one clip without losing chapter-local sentence indexes", () => {
  const chapters = [
    createChapter("一", [{ text: "已经听过。章末剩余一句。" }], 0)!,
    { id: "images", paragraphs: [], sentenceCount: 0 } as unknown as Chapter,
    createChapter("二", [{ text: "下一章第一句。下一章第二句。" }], 2)!,
  ];
  const book = { id: "book", chapters } as Book;
  const part = segmentFromBook(book, 0, 1, "edge", true)!;
  assert.equal(part.text, "章末剩余一句。\n下一章第一句。\n下一章第二句。");
  assert.deepEqual(part.spans.map(span => [span.chapterIndex, span.sentenceIndex]), [[0, 1], [2, 0], [2, 1]]);
  assert.equal(spanForBookSentence(part, 2, 0)?.sentenceId, chapters[2].paragraphs[0].sentences[0].id);
  assert.equal(spanForBookSentence(part, 0, 0), null);
  assert.deepEqual(nextBookSentence(book, 0, 2), { chapterIndex: 2, sentenceIndex: 0 });
  assert.equal(nextBookSentence(book, 2, 2), null);
});

test("the prefetched continuation starts at the exact next sentence across chapters, within the audio budget", () => {
  const chapters = [chapterOf(5), chapterOf(120), chapterOf(120)];
  const book = { id: "book", chapters } as Book;
  let at: { chapterIndex: number; sentenceIndex: number } | null = { chapterIndex: 0, sentenceIndex: 3 };
  const heard: string[] = [];
  let first = true;
  while (at) {
    const part = segmentFromBook(book, at.chapterIndex, at.sentenceIndex, "edge", first)!;
    assert.ok(part.text.length <= (first ? QUICK_SPEECH_LENGTH : 4800));
    heard.push(...part.spans.map(span => `${span.chapterIndex}:${span.sentenceIndex}`));
    const last = part.spans.at(-1)!;
    at = nextBookSentence(book, last.chapterIndex, last.sentenceIndex + 1);
    first = false;
  }
  const expected = chapters.flatMap((chapter, ci) => Array.from({ length: chapter.sentenceCount }, (_, si) => `${ci}:${si}`)).slice(3);
  assert.deepEqual(heard, expected, "no repeated or skipped sentences when clips end in later chapters");
});

test("chapter sleep mode and system fallback keep clips confined to one chapter", () => {
  const book = { id: "book", chapters: [chapterOf(2), chapterOf(10)] } as Book;
  assert.ok(segmentFromBook(book, 0, 1, "edge", false)!.spans.some(span => span.chapterIndex === 1));
  for (const engine of ["edge", "system"] as const) {
    assert.ok(segmentFromBook(book, 0, 1, engine, false, false)!.spans.every(span => span.chapterIndex === 0));
  }
});
