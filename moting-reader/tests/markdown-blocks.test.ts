import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { markdownBlocks } from "../lib/markdown-blocks.ts";
import { remarkPlugins } from "../lib/markdown-plugins.ts";

const render = (markdown: string) =>
  renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins }, markdown))
    .replace(/>\s+</g, "><")
    .trim();

const FENCE = "`".repeat(3);

const SAMPLES = [
  "开头一段，**加粗**。\n\n### 1. 小标题\n正文紧跟标题。\n\n第二段。",
  "- 一\n- 二\n\n- 松散列表的第三项\n\n  续行段落\n\n结尾段。",
  "1. 第一\n\n2. 第二\n\n3. 第三\n\n后面的段落",
  `说明：\n\n${FENCE}js\nconst a = 1;\n\nconst b = 2;\n${FENCE}\n\n代码后面的段落`,
  "| 误解 | 看法 |\n| --- | --- |\n| 放弃 | 起点 |\n\n表格后的段落",
  "> 引用一\n>\n> 引用二\n\n> 另一段引用\n\n正文",
  "* 父项\n    * 子项一\n\n    * 子项二\n\n* 父项二",
  "段落\n\n    缩进代码\n\n    第二行\n\n段落",
  "---\n\n分隔线后面",
];

test("splitting into blocks renders exactly like the whole document", () => {
  for (const sample of SAMPLES) {
    const blocks = markdownBlocks(sample);
    assert.equal(blocks.map(render).join(""), render(sample), sample);
  }
});

test("blocks split at top-level blank lines only", () => {
  assert.deepEqual(markdownBlocks("甲\n\n乙\n丙\n\n\n丁"), ["甲", "乙\n丙", "丁"]);
  // 围栏里的空行、松散列表、缩进续行都不切
  assert.equal(markdownBlocks(`${FENCE}\na\n\nb\n${FENCE}`).length, 1);
  assert.equal(markdownBlocks("- a\n\n- b").length, 1);
  assert.equal(markdownBlocks("1. a\n\n   续行").length, 1);
  // 列表之后接普通段落要切开
  assert.deepEqual(markdownBlocks("- a\n- b\n\n结尾"), ["- a\n- b", "结尾"]);
  // 有引用式定义就整篇不切
  assert.equal(markdownBlocks("见[文献][1]。\n\n[1]: https://example.com").length, 1);
});

test("bold next to Chinese punctuation renders as bold", () => {
  assert.match(render("这一章在讲**“真实”为什么重要**。"), /<strong>“真实”为什么重要<\/strong>/);
  assert.match(render("推荐**《昨日的世界》**这本书"), /<strong>《昨日的世界》<\/strong>/);
});

test("a still-open code fence keeps the rest of the stream in one block", () => {
  const streaming = `前言\n\n${FENCE}\n第一行\n\n第二行`;
  assert.deepEqual(markdownBlocks(streaming), ["前言", `${FENCE}\n第一行\n\n第二行`]);
});
