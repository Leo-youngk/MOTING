import test from "node:test";
import assert from "node:assert/strict";
import { createChapter, flattenChapter, positionFor } from "../lib/content.ts";
import { liveLocationAt, liveTimeFor, makeLivePlan, type LiveStatus } from "../lib/live-speech.ts";
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
