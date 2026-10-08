import test from "node:test";
import assert from "node:assert/strict";
import { createChapter, flattenChapter, positionFor } from "../lib/content.ts";
import { liveLocationAt, liveTimeFor, liveTimeAtChar, makeLivePlan, type LiveStatus } from "../lib/live-speech.ts";
import type { Book } from "../lib/types.ts";

test("a listening session starts at the saved sentence and tracks across chapters", () => {
  const chapters = [
    createChapter("一", [{ text: "第一句。第二句。第三句。" }], 0)!,
    createChapter("二", [{ text: "下一章首句。下一章第二句。" }], 1)!,
  ];
  const book = { id: "book", chapters } as Book;
  const position = positionFor(book, 0, 1);
  const plan = makeLivePlan(book, position);
  assert.ok(plan.text.startsWith(flattenChapter(chapters[0])[1].text));
  assert.equal(plan.sentences[0].sentenceIndex, 1);
  assert.equal(plan.sentences.at(-1)?.chapterIndex, 1);
  const boundary = plan.sentences.find(sentence => sentence.chapterIndex === 1)!;
  const status = {
    ready: true, complete: true, duration: 20, updated: 0,
    segments: [
      { number: 0, start: 0, end: boundary.start, duration: 10, time: 0, timeline: [] },
      { number: 1, start: boundary.start, end: plan.text.length, duration: 10, time: 10, timeline: [] },
    ],
  } as LiveStatus;
  assert.equal(liveLocationAt(plan, status, 12)?.chapterIndex, 1);
  assert.equal(liveTimeFor(plan, status, 1, 0), 10);
  assert.equal(liveTimeFor(plan, status, 0, 0), null);
});

test("seeking to a sentence cannot round back into the previous sentence", () => {
  const chapters = [createChapter("章", [{ text: "甲。".repeat(400) }], 0)!];
  const book = { id: "book", chapters } as Book;
  const plan = makeLivePlan(book, positionFor(book, 0, 0));
  const status = { ready: true, complete: true, duration: 90, updated: 0,
    segments: [{ number: 0, start: 0, end: plan.text.length, time: 0, duration: 90, timeline: [] }] } as LiveStatus;
  for (const sentence of plan.sentences) {
    assert.equal(liveLocationAt(plan, status, liveTimeFor(plan, status, 0, sentence.sentenceIndex)!)?.sentenceId, sentence.sentenceId);
  }
});

test("HLS handover locates the current character, including a sentence split between native segments", () => {
  const status = { segments: [
    { start: 0, end: 100, time: 0, duration: 20, timeline: [{ time: 0, charIndex: 0 }, { time: 20, charIndex: 100 }] },
    { start: 100, end: 200, time: 20, duration: 20, timeline: [{ time: 0, charIndex: 0 }, { time: 5, charIndex: 25 }, { time: 20, charIndex: 100 }] },
  ] } as LiveStatus;
  assert.equal(liveTimeAtChar(status, 125), 25);
  assert.equal(liveTimeAtChar(status, 250), null, "do not hand over to an unprepared section");
});
