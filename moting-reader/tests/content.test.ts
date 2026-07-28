import assert from "node:assert/strict";
import test from "node:test";

import {
  chaptersFromPlainText,
  createBook,
  createChapter,
  movePosition,
  positionFor,
  splitIntoSentences,
  toSpeakableText,
} from "../lib/content.ts";

test("按中文标点切分朗读句子", () => {
  assert.deepEqual(splitIntoSentences("第一句。第二句！还可以吗？可以；结束。"), [
    "第一句。",
    "第二句！",
    "还可以吗？",
    "可以；",
    "结束。",
  ]);
});

test("清理不适合朗读的标记和链接", () => {
  assert.equal(
    toSpeakableText("**正文**[注1]，详见 https://example.com/a。"),
    "正文，详见 链接。"
  );
});

test("识别章节并保留段落顺序", () => {
  const chapters = chaptersFromPlainText(
    "第一章 起点\n\n这是第一句。这是第二句。\n\n第二章 继续\n\n这是第三句。"
  );

  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].title, "第一章 起点");
  assert.equal(chapters[0].sentenceCount, 2);
  assert.equal(chapters[1].title, "第二章 继续");
});

test("阅读位置能够跨章节移动并计算进度", () => {
  const first = createChapter("第一章", ["甲。乙。"], 0);
  const second = createChapter("第二章", ["丙。丁。"], 1);
  assert.ok(first);
  assert.ok(second);

  const book = createBook({
    title: "测试书",
    format: "txt",
    chapters: [first, second],
  });
  const start = positionFor(book, 0, 0);
  const nextChapter = movePosition(book, 0, 1, 1);
  const end = positionFor(book, 1, 1);

  assert.equal(start.percent, 0);
  assert.equal(nextChapter.chapterIndex, 1);
  assert.equal(nextChapter.sentenceIndex, 0);
  assert.equal(end.percent, 100);
});
