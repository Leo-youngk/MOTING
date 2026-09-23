import assert from "node:assert/strict";
import test from "node:test";
import {
  chapterLabel,
  displayTitle,
  isPlaceholderTitle,
  tocIndexes,
  tocIndexFor,
} from "../lib/display-title.ts";

test("displayTitle drops trailing marketing parentheticals", () => {
  assert.equal(
    displayTitle(
      "你的夏天还好吗？（“韩国八零后天才女作家”金爱烂经典小说；豆瓣8.7分高分作品） (金爱烂作品集)"
    ),
    "你的夏天还好吗？"
  );
  assert.equal(
    displayTitle("复旦名师陈果：好的孤独+好的爱情（套装共2册）（用哲学的方式告诉你）"),
    "复旦名师陈果：好的孤独+好的爱情"
  );
  assert.equal(displayTitle("礼物_【波兰】切斯瓦夫·米沃什"), "礼物");
});

test("displayTitle keeps titles that have nothing to strip", () => {
  assert.equal(displayTitle("乱世华尔街,一位华人交易员的经历"), "乱世华尔街,一位华人交易员的经历");
  assert.equal(displayTitle("Atomic Habits"), "Atomic Habits");
  // 整个书名就是括号时不能剥成空的
  assert.equal(displayTitle("（续）"), "（续）");
  // 括号在中间的不动
  assert.equal(displayTitle("论（语）文"), "论（语）文");
});

test("placeholder chapters read as a continuation of the previous titled one", () => {
  const outline = [
    { title: "未知" },
    { title: "第一章 道可道" },
    { title: "未知" },
    { title: "Unknown" },
    { title: "第二章 天下皆知" },
  ];
  assert.equal(isPlaceholderTitle("  未知 "), true);
  assert.equal(isPlaceholderTitle("未知的世界"), false);
  assert.equal(chapterLabel(outline, 0), "卷首");
  assert.equal(chapterLabel(outline, 2), "第一章 道可道");
  assert.equal(chapterLabel(outline, 3), "第一章 道可道");
  assert.equal(chapterLabel(outline, 4), "第二章 天下皆知");
  assert.equal(chapterLabel([], 0), "正文");

  const toc = tocIndexes(outline);
  assert.deepEqual(toc, [0, 1, 4]);
  assert.equal(tocIndexFor(toc, 3), 1);
  assert.equal(tocIndexFor(toc, 4), 4);
  assert.equal(tocIndexFor(toc, 0), 0);
});
