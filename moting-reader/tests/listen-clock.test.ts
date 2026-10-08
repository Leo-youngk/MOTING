import assert from "node:assert/strict";
import test from "node:test";

import { createChapter } from "../lib/content.ts";
import { tocIndexes, tocRange } from "../lib/display-title.ts";
import {
  chapterDuration,
  formatClock,
  listenChapter,
  sentenceAfterSeconds,
  sentenceAtSeconds,
  sentenceSeconds,
  speechSeconds,
} from "../lib/listen-clock.ts";

function chapters() {
  const list = [
    createChapter("第一章", [{ text: "甲乙丙丁。戊己庚辛。" }], 0),
    createChapter("未知", [{ text: "壬癸子丑。" }], 1),
    createChapter("第二章", [{ text: "寅卯辰巳午。" }], 2),
  ];
  for (const chapter of list) assert.ok(chapter);
  return list as NonNullable<(typeof list)[number]>[];
}

test("中文按实测语速折算秒数，英文数字读得快", () => {
  assert.ok(Math.abs(speechSeconds("一二三四五六七八九十。") - 11 / 4.65) < 1e-9);
  assert.ok(speechSeconds("abcdefghij") < speechSeconds("一二三四五六七八九十"));
  assert.equal(speechSeconds(""), 0);
});

test("续页并进前一章：时长和进度条都按目录里的一项算", () => {
  const list = chapters();
  const toc = tocIndexes(list);
  assert.deepEqual(tocRange(toc, 1, list.length), { first: 0, last: 1 });
  assert.deepEqual(tocRange(toc, 2, list.length), { first: 2, last: 2 });

  const first = listenChapter(list, 0, 1);
  assert.equal(first.sentences.length, 3);
  // 续页里那一句接着前一章往下数，不从零重来。
  const continued = sentenceSeconds(first, 1, 0);
  assert.ok(continued.start > 0);
  assert.equal(continued.end, chapterDuration(first));
  assert.equal(sentenceSeconds(first, 0, 0).start, 0);
});

test("拖到第几秒就落在正在读的那一句，两端越界收回来", () => {
  const first = listenChapter(chapters(), 0, 1);
  const second = sentenceSeconds(first, 0, 1);
  assert.deepEqual(sentenceAtSeconds(first, second.start), { chapterIndex: 0, sentenceIndex: 1 });
  assert.deepEqual(sentenceAtSeconds(first, second.end - 0.01), { chapterIndex: 0, sentenceIndex: 1 });
  assert.deepEqual(sentenceAtSeconds(first, -5), { chapterIndex: 0, sentenceIndex: 0 });
  assert.deepEqual(sentenceAtSeconds(first, 1e9), { chapterIndex: 1, sentenceIndex: 0 });
});

test("按秒数挪位置：跨章、跳过空章，两头停在端点", () => {
  const list = [
    createChapter("第一章", [{ text: "甲乙丙丁。戊己庚辛。" }], 0),
    createChapter("插图", [], 1),
    createChapter("第二章", [{ text: "寅卯辰巳午。未申酉戌亥。" }], 2),
  ] as NonNullable<ReturnType<typeof createChapter>>[];
  const one = speechSeconds("甲乙丙丁。");
  // 不满一句停在这一句。
  assert.deepEqual(sentenceAfterSeconds(list, 0, 0, one - 0.1), { chapterIndex: 0, sentenceIndex: 0 });
  assert.deepEqual(sentenceAfterSeconds(list, 0, 0, one + 0.1), { chapterIndex: 0, sentenceIndex: 1 });
  // 跨过空章接到下一章。
  assert.deepEqual(sentenceAfterSeconds(list, 0, 1, one + 0.1), { chapterIndex: 2, sentenceIndex: 0 });
  assert.deepEqual(sentenceAfterSeconds(list, 2, 0, -0.1), { chapterIndex: 0, sentenceIndex: 1 });
  assert.deepEqual(sentenceAfterSeconds(list, 2, 1, 1e6), { chapterIndex: 2, sentenceIndex: 1 });
  assert.deepEqual(sentenceAfterSeconds(list, 0, 1, -1e6), { chapterIndex: 0, sentenceIndex: 0 });
});

test("时钟格式：不满一小时 mm:ss，超过带小时", () => {
  assert.equal(formatClock(0), "00:00");
  assert.equal(formatClock(201.4), "03:21");
  assert.equal(formatClock(3723), "1:02:03");
  assert.equal(formatClock(-3), "00:00");
});
