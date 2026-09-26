import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEdgeSpeechBatches,
  buildSpeechBlocks,
  chaptersFromPlainText,
  charsPerLine,
  createBook,
  createChapter,
  formatRemaining,
  movePosition,
  outlineOf,
  planChapterWindow,
  positionAtPercent,
  positionFor,
  remainingCharacters,
  sliceSpeechBlock,
  splitBlocksIntoSections,
  splitIntoSentences,
  toSpeakableText,
} from "../lib/content.ts";
import type { BlockInput } from "../lib/content.ts";

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

test("插图成块但不进句子流，缺图源的插图直接丢掉", () => {
  const chapter = createChapter(
    "第一章",
    [
      { text: "正文一句。" },
      { kind: "image", text: "", imageId: "image-1", alt: "一张插图" },
      { kind: "image", text: "" },
      { text: "正文二句。" },
    ],
    0
  );
  assert.ok(chapter);

  assert.deepEqual(
    chapter.paragraphs.map((paragraph) => paragraph.kind),
    ["text", "image", "text"]
  );
  assert.equal(chapter.paragraphs[1].alt, "一张插图");
  assert.equal(chapter.paragraphs[1].sentences.length, 0);
  assert.equal(chapter.sentenceCount, 2);
  assert.equal(buildSpeechBlocks(chapter).length, 2);
});

test("插图尺寸随正文一起存下来", () => {
  const chapter = createChapter(
    "第一章",
    [
      { text: "正文一句。" },
      { kind: "image", text: "", imageId: "image-1", imageWidth: 800, imageHeight: 600 },
      { kind: "image", text: "", imageId: "image-2" },
    ],
    0
  );
  assert.ok(chapter);
  assert.equal(chapter.paragraphs[1].imageWidth, 800);
  assert.equal(chapter.paragraphs[1].imageHeight, 600);
  assert.equal(chapter.paragraphs[2].imageHeight, undefined);
});

test("书目里的目录跟正文一致，剩余时长只看书目就能算", () => {
  const chapters = chaptersFromPlainText(
    "第一章 起点\n\n这是第一句。这是第二句。\n\n第二章 继续\n\n这是第三句，比前面长一些。"
  );
  const book = createBook({ title: "目录", author: "", format: "txt", chapters });
  assert.deepEqual(outlineOf(chapters), book.chapterOutline);
  assert.deepEqual(
    book.chapterOutline.map((item) => [item.id, item.title, item.sentenceCount, item.characterCount]),
    chapters.map((chapter) => [chapter.id, chapter.title, chapter.sentenceCount, chapter.characterCount])
  );

  // 书库里只有书目、没有正文：剩余时长照样算得出来，跟拿整本书算的一样。
  const { chapters: _chapters, ...meta } = book;
  const position = { chapterId: chapters[0].id, chapterIndex: 0, sentenceId: "", sentenceIndex: 1, percent: 30, updatedAt: 0 };
  assert.equal(remainingCharacters(meta, position), remainingCharacters(book, position));
  assert.equal(
    remainingCharacters(meta, position),
    chapters[0].characterCount / 2 + chapters[1].characterCount
  );
  assert.equal(formatRemaining(meta), formatRemaining(book));
});

test("只有插图没有正文时不算一章", () => {
  assert.equal(
    createChapter("插图页", [{ kind: "image", text: "", imageId: "image-1" }], 0),
    null
  );
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

test("云端朗读批次跨段落合并并保持句子下标", () => {
  const chapter = createChapter(
    "第一章",
    [{ text: "甲。乙。" }, { text: "丙。丁。" }, { text: "戊。" }],
    0
  );
  assert.ok(chapter);

  const batches = buildEdgeSpeechBatches(chapter, 7);
  assert.deepEqual(
    batches.map((batch) => batch.text),
    ["甲。乙。丙。", "丁。戊。"]
  );
  assert.deepEqual(
    batches.flatMap((batch) => batch.spans.map((span) => span.sentenceIndex)),
    [0, 1, 2, 3, 4]
  );
  for (const batch of batches) {
    for (const span of batch.spans) {
      assert.equal(
        batch.text.slice(span.start, span.end),
        chapter.paragraphs
          .flatMap((paragraph) => paragraph.sentences)
          [span.sentenceIndex].speakableText
      );
    }
  }
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

test("进度条拖到哪个百分比就落在对应的章和句，读回来还是那个百分比", () => {
  const first = createChapter("第一章", [{ text: "甲。乙。丙。" }], 0);
  const second = createChapter("第二章", [{ text: "丁。戊。己。庚。" }], 1);
  assert.ok(first);
  assert.ok(second);
  const book = createBook({ title: "测试书", format: "txt", chapters: [first, second] });

  const start = positionAtPercent(book, 0);
  assert.equal(start.chapterIndex, 0);
  assert.equal(start.sentenceIndex, 0);

  // 共 7 句，第 4 句（下标 3）是第二章的第一句，50% 正好落在它上面。
  const middle = positionAtPercent(book, 50);
  assert.equal(middle.chapterIndex, 1);
  assert.equal(middle.sentenceIndex, 0);
  assert.equal(middle.percent, 50);

  const end = positionAtPercent(book, 100);
  assert.equal(end.chapterIndex, 1);
  assert.equal(end.sentenceIndex, 3);
  assert.equal(end.percent, 100);

  // 越界的值收回到两端，不抛错。
  assert.equal(positionAtPercent(book, -20).percent, 0);
  assert.equal(positionAtPercent(book, 180).percent, 100);
});

const VIEW = 800;
/** 按章高依次排开，offset 是第一章顶边相对视口的位置。 */
const layoutSections = (start: number, heights: number[], offset: number) => {
  let top = offset;
  return heights.map((height, i) => {
    const section = { index: start + i, top, bottom: top + height };
    top += height;
    return section;
  });
};
const plan = (
  range: { start: number; end: number },
  sections: ReturnType<typeof layoutSections>,
  primed: number[] = sections.map((section) => section.index)
) =>
  planChapterWindow({
    range,
    lastChapter: 11,
    primed: new Set(primed),
    sections,
    viewportHeight: VIEW,
    buffer: 2400,
    trimDistance: 4800,
  });

test("连续滚动窗口：视口附近还没排版的章先排，往上翻时它就不会再被撑开", () => {
  // 视口在第 5 章里，第 4 章（上方）和第 6 章（下方）都没排版，先排离得近的上方那章。
  const sections = layoutSections(4, [3000, 3000, 3000], -3500);
  assert.deepEqual(plan({ start: 4, end: 6 }, sections, [5]), {
    kind: "prime",
    index: 4,
  });
});

test("连续滚动窗口：上方缓冲不够就往回接一章，下方不够就往下接", () => {
  // 刚跳到第 5 章章首：上方什么都没有。
  assert.deepEqual(
    plan({ start: 5, end: 5 }, layoutSections(5, [9000], 0)),
    { kind: "prepend" }
  );
  // 上方够了，下方只剩半屏。
  assert.deepEqual(
    plan({ start: 4, end: 5 }, layoutSections(4, [4000, 1200], -4000)),
    { kind: "append" }
  );
});

test("连续滚动窗口：到书的两端就不再往外接", () => {
  assert.equal(plan({ start: 0, end: 0 }, layoutSections(0, [9000], 0)), null);
  // 读到最后一章末尾：下方没有了，上方已经够。
  assert.equal(
    plan({ start: 10, end: 11 }, layoutSections(10, [4000, 1000], -4200)),
    null
  );
});

test("连续滚动窗口：缓冲补够之后再去排远处的章", () => {
  // 下方第 7 章离视口 4000px 以外，没排版；上下缓冲都够了才轮到它。
  const sections = layoutSections(4, [3000, 3000, 3000, 3000], -4000);
  assert.deepEqual(plan({ start: 4, end: 7 }, sections, [4, 5, 6]), {
    kind: "prime",
    index: 7,
  });
});

test("连续滚动窗口：远到用不上的章才摘，摘完两头缓冲仍然够", () => {
  // 第 2 章整章都在视口上方 6000px 以外。
  const far = layoutSections(2, [3000, 3000, 3000, 9000], -12000);
  assert.deepEqual(plan({ start: 2, end: 5 }, far), { kind: "trim-start" });
  // 末章顶边在视口下方 5000px 以外。
  const below = layoutSections(4, [3000, 9000, 3000], -3000);
  assert.deepEqual(plan({ start: 4, end: 6 }, below), { kind: "trim-end" });
  // 只差一点点够不上摘章距离的就留着，免得摘了又接、来回抖。
  const near = layoutSections(2, [3000, 3000, 9000], -5000);
  assert.equal(plan({ start: 2, end: 4 }, near), null);
});

const longText = (chars: number) => "字".repeat(chars) + "。";

test("切章：文件规模正常时原样返回，不把章内小标题拆成章", () => {
  const sections = splitBlocksIntoSections(
    [
      { text: "开头一段。" },
      { kind: "heading", level: 2, text: "第一节" },
      { text: "小节正文。" },
    ],
    "第三章"
  );
  assert.equal(sections.length, 1);
  assert.equal(sections[0].title, "第三章");
  // 标题仍然留在正文里当小标题，没被吃掉
  assert.equal(sections[0].blocks.length, 3);
});

test("切章：整本书塞进一个文件时按最浅一级标题切开", () => {
  const blocks: BlockInput[] = [{ text: "题记。" }];
  for (let i = 1; i <= 4; i++) {
    blocks.push({ kind: "heading", level: 2, text: `第${i}章` });
    blocks.push({ text: longText(2000) });
    // h3 是章内小标题，不该各自成章
    blocks.push({ kind: "heading", level: 3, text: `${i}.1 小节` });
    blocks.push({ text: longText(500) });
  }

  const sections = splitBlocksIntoSections(blocks, "白鹿原");
  assert.deepEqual(
    sections.map((section) => section.title),
    ["白鹿原", "第1章", "第2章", "第3章", "第4章"]
  );
  // 章标题变成章名，不再作为段落重复一遍；h3 留在正文里
  assert.deepEqual(
    sections[1].blocks.map((block) => block.kind ?? "text"),
    ["text", "heading", "text"]
  );
  assert.equal(sections[0].blocks.length, 1);
});

test("切章：没有标题可切的超长文件按规模硬切", () => {
  const blocks: BlockInput[] = Array.from({ length: 30 }, () => ({
    text: longText(1000),
  }));
  const sections = splitBlocksIntoSections(blocks, "正文");
  assert.ok(sections.length >= 3, `实际切了 ${sections.length} 段`);
  assert.deepEqual(sections[0].title, "正文 · 1");
  // 块不能被劈开，所以每段最多超出上限一个块的量
  for (const section of sections) {
    const chars = section.blocks.reduce((sum, b) => sum + b.text.length, 0);
    assert.ok(chars <= 8000 + 1001, `单段 ${chars} 字，超了`);
  }
  // 一个块都不能丢
  assert.equal(
    sections.reduce((sum, s) => sum + s.blocks.length, 0),
    blocks.length
  );
});

test("切章：段落短但极多的文件也会被切开", () => {
  const blocks: BlockInput[] = Array.from({ length: 900 }, () => ({
    text: "很短的一句话。",
  }));
  const sections = splitBlocksIntoSections(blocks, "对白");
  assert.ok(sections.length >= 4, `实际切了 ${sections.length} 段`);
  for (const section of sections) {
    assert.ok(
      section.blocks.length <= 201,
      `单段 ${section.blocks.length} 段，超了`
    );
  }
});

test("一行字数按正文栏宽算：窄屏扣掉左右留白，宽屏被阅读宽度封顶", () => {
  // 390 宽的手机：栏宽 348，18px 字号一行 19 个字。
  assert.equal(charsPerLine({ fontSize: 18, contentWidth: 680 }, 390), 19);
  // 桌面宽屏：栏宽取阅读宽度 680。
  assert.equal(charsPerLine({ fontSize: 20, contentWidth: 680 }, 1440), 34);
  // 极端大字号也至少按 8 个字估，占位高度不会被放大到离谱。
  assert.equal(charsPerLine({ fontSize: 60, contentWidth: 680 }, 320), 8);
});
