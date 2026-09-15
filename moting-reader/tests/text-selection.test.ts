import assert from "node:assert/strict";
import test from "node:test";

import {
  comparePlaces,
  expandToWord,
  isEmptySelection,
  orderedSelection,
  selectionParts,
  selectionText,
  type SelectionSentence,
  type TextSelection,
} from "../lib/text-selection.ts";

const sentences: SelectionSentence[] = [
  { chapterIndex: 0, sentenceIndex: 0, sentenceId: "s0", text: "他抬头望向窗外。" },
  { chapterIndex: 0, sentenceIndex: 1, sentenceId: "s1", text: "暮色漫过屋脊。" },
  { chapterIndex: 0, sentenceIndex: 2, sentenceId: "s2", text: "远处有钟声。" },
  { chapterIndex: 1, sentenceIndex: 0, sentenceId: "s3", text: "第二章开始了。" },
];

test("长按表情和组合字符不会只选中半个字符", () => {
  for (const glyph of ["😀", "👨‍👩‍👧‍👦", "e\u0301", "🇨🇳"]) {
    const text = `前${glyph}后`;
    for (let offset = 1; offset < 1 + glyph.length; offset++) {
      const word = expandToWord(text, offset);
      assert.equal(text.slice(word.start, word.end), glyph);
    }
  }
});

const place = (sentenceIndex: number, offset: number, chapterIndex = 0) => ({
  chapterIndex,
  sentenceIndex,
  sentenceId: `s${chapterIndex === 0 ? sentenceIndex : 3}`,
  offset,
});

test("句内部分选择只取那一截", () => {
  const selection: TextSelection = { anchor: place(0, 1), focus: place(0, 5) };
  const parts = selectionParts(selection, sentences);

  assert.equal(parts.length, 1);
  assert.deepEqual(
    { start: parts[0].start, end: parts[0].end, text: parts[0].text },
    { start: 1, end: 5, text: "抬头望向" }
  );
});

test("跨句选择按句拆开，首尾裁到偏移、中间整句", () => {
  const selection: TextSelection = { anchor: place(0, 5), focus: place(2, 2) };
  const parts = selectionParts(selection, sentences);

  assert.deepEqual(
    parts.map((part) => part.sentenceId),
    ["s0", "s1", "s2"]
  );
  assert.equal(parts[0].text, "窗外。");
  assert.equal(parts[1].text, "暮色漫过屋脊。", "中间的句子整句纳入");
  assert.equal(parts[2].text, "远处");
  assert.equal(selectionText(parts), "窗外。暮色漫过屋脊。远处");
});

test("反着拖手柄结果一样", () => {
  const forward: TextSelection = { anchor: place(0, 5), focus: place(2, 2) };
  const backward: TextSelection = { anchor: place(2, 2), focus: place(0, 5) };

  assert.deepEqual(selectionParts(backward, sentences), selectionParts(forward, sentences));
  assert.equal(orderedSelection(backward).start.sentenceIndex, 0);
  assert.equal(orderedSelection(backward).end.sentenceIndex, 2);
});

test("跨章选择按章序排在后面", () => {
  const selection: TextSelection = {
    anchor: place(2, 3),
    focus: place(0, 3, 1),
  };
  const parts = selectionParts(selection, sentences);

  assert.deepEqual(
    parts.map((part) => part.sentenceId),
    ["s2", "s3"]
  );
  assert.equal(parts[1].text, "第二章");
  assert.ok(comparePlaces(place(2, 0), place(0, 0, 1)) < 0, "第二章的第 0 句排在第一章之后");
});

test("空选区不产出任何片段", () => {
  const selection: TextSelection = { anchor: place(1, 3), focus: place(1, 3) };
  assert.ok(isEmptySelection(selection));
  assert.deepEqual(selectionParts(selection, sentences), []);
});

test("偏移越界会被夹回句子长度之内", () => {
  const selection: TextSelection = { anchor: place(1, -5), focus: place(1, 999) };
  const parts = selectionParts(selection, sentences);

  assert.equal(parts.length, 1);
  assert.equal(parts[0].start, 0);
  assert.equal(parts[0].end, sentences[1].text.length);
});

test("长按初选取到一个词而不是整句", () => {
  const text = "他抬头望向窗外。";
  const word = expandToWord(text, 1);

  assert.ok(word.end > word.start);
  assert.ok(word.end - word.start < text.length, "初选不能直接把整句圈进去");
  assert.ok(word.start <= 1 && word.end > 1, "选中的词要盖住手指落点");
});

test("英文单词整串选中", () => {
  const text = "他读的是 Moting Reader 这本书。";
  const at = text.indexOf("Reader") + 2;
  const word = expandToWord(text, at);

  assert.equal(text.slice(word.start, word.end), "Reader");
});

test("落在标点上只取一个字符，留给用户拖手柄", () => {
  const text = "他抬头望向窗外。";
  const word = expandToWord(text, text.length - 1);

  assert.equal(word.end - word.start, 1);
  assert.equal(text.slice(word.start, word.end), "。");
});

test("空串和越界偏移不会炸", () => {
  assert.deepEqual(expandToWord("", 0), { start: 0, end: 0 });
  const word = expandToWord("短句", 99);
  assert.ok(word.start >= 0 && word.end <= 2);
});

test("带表情的文本不会切出越界下标", () => {
  const text = "他笑了🙂又哭了。";
  for (let offset = 0; offset < text.length; offset += 1) {
    const word = expandToWord(text, offset);
    assert.ok(word.start >= 0, `start 越界 @${offset}`);
    assert.ok(word.end <= text.length, `end 越界 @${offset}`);
    assert.ok(word.end >= word.start, `区间反了 @${offset}`);
  }
});
