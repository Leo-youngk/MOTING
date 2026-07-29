import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSpeechBlocks,
  chaptersFromPlainText,
  createBook,
  createChapter,
  movePosition,
  positionFor,
  sliceSpeechBlock,
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

test("章内小标题保留为标题块而不是另起一章", () => {
  const chapters = chaptersFromPlainText(
    "# 第一章 起点\n\n开场的话。\n\n### 第一节 小标题\n\n小节正文。\n\n第二节 另一个\n\n又一段。"
  );

  assert.equal(chapters.length, 1);
  assert.deepEqual(
    chapters[0].paragraphs.map((paragraph) => paragraph.kind),
    ["text", "heading", "text", "heading", "text"]
  );
  assert.equal(chapters[0].paragraphs[1].level, 3);
  assert.equal(chapters[0].paragraphs[1].sentences[0].text, "第一节 小标题");
  // 标题也要能被朗读，所以仍然进句子流。
  assert.equal(chapters[0].sentenceCount, 5);
});

test("正文块默认是 text，标题块夹带层级", () => {
  const chapter = createChapter(
    "第一章",
    [
      { text: "正文一句。" },
      { kind: "heading", level: 9, text: "越界的层级" },
      { kind: "quote", text: "引文一句。" },
      { kind: "list", text: "列表一项。" },
    ],
    0
  );
  assert.ok(chapter);
  assert.deepEqual(
    chapter.paragraphs.map((paragraph) => paragraph.kind),
    ["text", "heading", "quote", "list"]
  );
  assert.equal(chapter.paragraphs[1].level, 6);
  assert.equal(chapter.paragraphs[0].level, undefined);
});

test("整段合成一条朗读块并记录每句偏移", () => {
  const chapter = createChapter("第一章", [{ text: "甲。乙。" }, { text: "丙。" }], 0);
  assert.ok(chapter);

  const blocks = buildSpeechBlocks(chapter);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, "甲。乙。");
  assert.deepEqual(
    blocks[0].spans.map((span) => [span.sentenceIndex, span.start, span.end]),
    [
      [0, 0, 2],
      [1, 2, 4],
    ]
  );
  assert.equal(blocks[1].spans[0].sentenceIndex, 2);

  for (const block of blocks) {
    for (const span of block.spans) {
      assert.equal(
        block.text.slice(span.start, span.end),
        chapter.paragraphs
          .flatMap((paragraph) => paragraph.sentences)
          [span.sentenceIndex].speakableText
      );
    }
  }
});

test("从句子中途续播时重新对齐偏移", () => {
  const chapter = createChapter("第一章", [{ text: "甲。乙。丙。" }], 0);
  assert.ok(chapter);

  const block = buildSpeechBlocks(chapter)[0];
  const sliced = sliceSpeechBlock(block, 1);

  assert.equal(sliced.text, "乙。丙。");
  assert.equal(sliced.spans[0].sentenceIndex, 1);
  assert.equal(sliced.spans[0].start, 0);
  assert.equal(sliced.text.slice(sliced.spans[1].start, sliced.spans[1].end), "丙。");
});

test("超长段落按句子边界切成多块", () => {
  const long = Array.from({ length: 40 }, (_, index) => `第${index}句内容填充。`).join("");
  const chapter = createChapter("第一章", [{ text: long }], 0);
  assert.ok(chapter);

  const blocks = buildSpeechBlocks(chapter);
  assert.ok(blocks.length >= 2);
  assert.equal(
    blocks.map((block) => block.text).join(""),
    chapter.paragraphs[0].sentences.map((sentence) => sentence.speakableText).join("")
  );
});

test("阅读位置能够跨章节移动并计算进度", () => {
  const first = createChapter("第一章", [{ text: "甲。乙。" }], 0);
  const second = createChapter("第二章", [{ text: "丙。丁。" }], 1);
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
