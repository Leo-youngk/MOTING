import assert from "node:assert/strict";
import test from "node:test";

import { followScrollDelta, newerPosition } from "../lib/follow-speech.ts";
import type { BookPosition } from "../lib/types.ts";

function at(chapterIndex: number, sentenceIndex: number, updatedAt: number): BookPosition {
  return {
    chapterId: `c${chapterIndex}`,
    chapterIndex,
    sentenceId: `s${chapterIndex}-${sentenceIndex}`,
    sentenceIndex,
    percent: 0,
    updatedAt,
  };
}

test("开始听取听、读两处里后动过的那处", () => {
  const read = at(16, 40, 2_000);
  const listen = at(17, 236, 1_000);
  assert.equal(newerPosition(read, listen), read, "电脑上后读到的第 16 章比手机早先听到的新");
  assert.equal(newerPosition(at(16, 40, 1_000), at(17, 236, 2_000))?.sentenceIndex, 236);
  assert.equal(newerPosition(undefined, listen), listen);
  assert.equal(newerPosition(read, undefined), read);
  assert.equal(newerPosition(undefined, undefined), undefined);
});

const VIEWPORT = 852;
const ANCHOR = 150;

test("朗读句还在锚点线到屏幕四分之三之间时正文不动", () => {
  assert.equal(followScrollDelta(150, 180, VIEWPORT, ANCHOR), 0, "正好在线上");
  assert.equal(followScrollDelta(400, 460, VIEWPORT, ANCHOR), 0, "线下面、整句看得见");
  assert.equal(followScrollDelta(110, 140, VIEWPORT, ANCHOR), 0, "略高于线，还算在线上");
});

test("朗读句往下走出舒适区就翻到锚点线上", () => {
  assert.equal(followScrollDelta(620, 660, VIEWPORT, ANCHOR), 470);
  assert.equal(followScrollDelta(1400, 1440, VIEWPORT, ANCHOR), 1250, "已经在屏幕外面");
});

test("朗读句跑到上面去了（往回跳）就往回滚", () => {
  assert.equal(followScrollDelta(-300, -270, VIEWPORT, ANCHOR), -450);
});

test("停在线上的长句底边出了屏也不往回倒", () => {
  assert.equal(followScrollDelta(160, 1200, VIEWPORT, ANCHOR), 0);
});
