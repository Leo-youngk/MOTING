import assert from "node:assert/strict";
import test from "node:test";

import { createChapter, flattenChapter } from "../lib/content.ts";
import {
  cursorAfterSeconds,
  GRID_LENGTH,
  gridSegmentAt,
  nextTier,
  ordinalOf,
  spanForSentence,
  speechIndexFor,
  speechReplacer,
  speechSegment,
  systemSegment,
  TIER_LENGTH,
  type SpeechCursor,
  type SpeechSegment,
  type SpeechTier,
} from "../lib/speech-segments.ts";
import type { Chapter } from "../lib/types.ts";

function chapter(title: string, paragraphs: string[], order = 0, heading = true): Chapter {
  const blocks = [
    ...(heading ? [{ kind: "heading" as const, text: title, level: 2 }] : []),
    ...paragraphs.map((text) => ({ text })),
  ];
  const result = createChapter(title, blocks, order);
  assert.ok(result);
  return result;
}

/** 一本 count 章的书，每章 paragraphs 段，每段 sentences 句，每句约 length 字。 */
function book(count: number, paragraphs = 6, sentences = 5, length = 24): Chapter[] {
  return Array.from({ length: count }, (_, chapterIndex) =>
    chapter(
      `第${chapterIndex + 1}章`,
      Array.from({ length: paragraphs }, (_, paragraph) =>
        Array.from(
          { length: sentences },
          (_, sentence) => `${chapterIndex}-${paragraph}-${sentence}${"墨".repeat(length)}。`
        ).join("")
      ),
      chapterIndex
    )
  );
}

function speakableOf(chapters: Chapter[], chapterIndex: number, sentenceIndex: number) {
  const sentence = flattenChapter(chapters[chapterIndex])[sentenceIndex];
  return sentence.speakableText || sentence.text;
}

/** 照播放器的接法一段接一段读到底。 */
function playThrough(chapters: Chapter[], from: SpeechCursor, maxSegments = 200): SpeechSegment[] {
  const index = speechIndexFor(chapters);
  const segments: SpeechSegment[] = [];
  let cursor: SpeechCursor | null = from;
  let tier: SpeechTier = 0;
  while (cursor && segments.length < maxSegments) {
    const segment = speechSegment(index, cursor, tier);
    assert.ok(segment);
    segments.push(segment);
    cursor = segment.next;
    tier = nextTier(tier);
  }
  return segments;
}

test("换段、标题、换章用不同的换行分隔，续页章按换段算", () => {
  const chapters = [
    chapter("第一章", ["甲。乙。", "丙。"], 0),
    chapter("未知", ["丁。"], 1, false),
    chapter("第二章", ["戊。"], 2),
  ];
  const index = speechIndexFor(chapters);
  const segment = speechSegment(index, { chapterIndex: 0, sentenceIndex: 0 }, 0);
  assert.ok(segment);
  assert.equal(segment.text, "第一章\n\n甲。乙。\n丙。\n丁。\n\n\n第二章\n\n戊。");
  assert.deepEqual(
    segment.spans.map((span) => [span.chapterIndex, span.sentenceIndex]),
    [[0, 0], [0, 1], [0, 2], [0, 3], [1, 0], [2, 0], [2, 1]]
  );
  for (const span of segment.spans) {
    assert.equal(
      segment.text.slice(span.start, span.end),
      speakableOf(chapters, span.chapterIndex, span.sentenceIndex)
    );
  }
  assert.equal(segment.next, null);
});

test("首段 360 字以内、可以跨章；段尾带上跟下一句之间的换行", () => {
  const chapters = book(3, 2, 3, 40);
  const index = speechIndexFor(chapters);
  const last = flattenChapter(chapters[0]).length - 1;
  const segment = speechSegment(index, { chapterIndex: 0, sentenceIndex: last }, 0);
  assert.ok(segment);
  assert.ok(segment.text.length <= TIER_LENGTH[0] + 3);
  assert.equal(segment.spans[0].chapterIndex, 0);
  assert.equal(segment.spans[1].chapterIndex, 1, "章末起播直接接下一章，不会只读一句就去等网络");
  if (segment.next && ordinalOf(index, segment.next) >= 0) {
    const nextSeparator = index.sentences[ordinalOf(index, segment.next)].separator;
    if (nextSeparator.startsWith("\n")) assert.ok(segment.text.endsWith(nextSeparator));
  }
});

test("一段接一段读到底，每句恰好读一次，跨章也不重不漏", () => {
  const chapters = book(6);
  const segments = playThrough(chapters, { chapterIndex: 1, sentenceIndex: 7 });
  const read = segments.flatMap((segment) =>
    segment.spans.map((span) => `${span.chapterIndex}:${span.sentenceIndex}`)
  );
  const expected = chapters.flatMap((item, chapterIndex) =>
    flattenChapter(item).map((_, sentenceIndex) => `${chapterIndex}:${sentenceIndex}`)
  );
  assert.deepEqual(read, expected.slice(expected.indexOf("1:7")));
  assert.deepEqual(
    segments.slice(0, 3).map((segment) => segment.tier),
    [0, 1, 2]
  );
  assert.ok(segments[0].text.length <= TIER_LENGTH[0] + 3);
  assert.ok(segments[1].text.length <= TIER_LENGTH[1] + 3);
});

test("长批次对齐网格：从不同地方开始听，读一阵之后请求的文本完全一样", () => {
  const chapters = book(30);
  const a = playThrough(chapters, { chapterIndex: 0, sentenceIndex: 3 });
  const b = playThrough(chapters, { chapterIndex: 1, sentenceIndex: 11 });
  const tail = (segments: SpeechSegment[]) => segments.slice(4).map((segment) => segment.text);
  const shared = tail(b).filter((text) => tail(a).includes(text));
  assert.ok(shared.length >= 2, "后面的格子应该一字不差，缓存才能复用");
  for (const segment of a.slice(3)) {
    assert.ok(segment.text.length <= GRID_LENGTH + 200, "一格不超过网格长度（加上段尾分隔）");
  }
});

test("格子里剩得太少就连下一格一起读", () => {
  const chapters = book(12);
  const index = speechIndexFor(chapters);
  const secondCell = index.grid[1];
  const nearEnd = index.sentences[secondCell - 2];
  const segment = speechSegment(index, nearEnd, 2);
  assert.ok(segment);
  assert.ok(segment.spans.length > 2, "不能只读格子末尾那两句");
  assert.equal(
    ordinalOf(index, segment.next ?? { chapterIndex: -1, sentenceIndex: 0 }),
    index.grid[2] ?? -1
  );
});

test("本地有整格音频时能从格子中间播", () => {
  const chapters = book(8);
  const index = speechIndexFor(chapters);
  const cursor = { chapterIndex: 2, sentenceIndex: 9 };
  const cell = gridSegmentAt(index, cursor);
  assert.ok(cell);
  assert.ok(spanForSentence(cell, cursor), "整格要包含这一句");
  assert.ok(index.grid.includes(ordinalOf(index, cell.spans[0])), "从格子开头起");
  assert.equal(spanForSentence(cell, { chapterIndex: 99, sentenceIndex: 0 }), null);
});

test("读音替换：长规则优先，空规则忽略，偏移按替换后的文本算", () => {
  const replace = speechReplacer([
    { from: "长", to: "常" },
    { from: "长大", to: "涨大" },
    { from: "", to: "x" },
  ]);
  assert.equal(replace("他长大了，长得很长"), "他涨大了，常得很常");

  const chapters = [chapter("第一章", ["行长说。银行很大。"], 0, false)];
  const index = speechIndexFor(chapters);
  const segment = speechSegment(
    index,
    { chapterIndex: 0, sentenceIndex: 0 },
    0,
    speechReplacer([{ from: "行长", to: "航长" }])
  );
  assert.ok(segment);
  assert.equal(segment.text, "航长说。银行很大。");
  assert.equal(segment.text.slice(segment.spans[1].start, segment.spans[1].end), "银行很大。");
});

test("系统朗读一块不跨章，读完指向下一章开头", () => {
  const chapters = book(2, 1, 3, 10);
  const lastSentence = flattenChapter(chapters[0]).length - 1;
  const segment = systemSegment(chapters, { chapterIndex: 0, sentenceIndex: lastSentence });
  assert.ok(segment);
  assert.ok(segment.spans.every((span) => span.chapterIndex === 0));
  assert.deepEqual(segment.next, { chapterIndex: 1, sentenceIndex: 0 });
  assert.equal(systemSegment(chapters, { chapterIndex: 9, sentenceIndex: 0 }), null);
});

test("按估算时长往前往后挪", () => {
  const chapters = book(3, 4, 5, 20);
  const index = speechIndexFor(chapters);
  const from = { chapterIndex: 1, sentenceIndex: 10 };
  // 每句 20 多个字，按 4.65 字/秒大约 5 秒。
  const forward = cursorAfterSeconds(index, from, 15);
  const backward = cursorAfterSeconds(index, from, -15);
  assert.ok(forward && backward);
  assert.ok(forward.sentenceIndex > from.sentenceIndex && forward.sentenceIndex <= from.sentenceIndex + 3);
  assert.ok(backward.sentenceIndex < from.sentenceIndex && backward.sentenceIndex >= from.sentenceIndex - 4);
  assert.deepEqual(cursorAfterSeconds(index, { chapterIndex: 0, sentenceIndex: 0 }, -60), {
    chapterIndex: 0,
    sentenceIndex: 0,
  });
  const lastChapter = chapters.length - 1;
  const lastSentence = flattenChapter(chapters[lastChapter]).length - 1;
  assert.deepEqual(cursorAfterSeconds(index, { chapterIndex: lastChapter, sentenceIndex: 0 }, 1e6), {
    chapterIndex: lastChapter,
    sentenceIndex: lastSentence,
  });
});
