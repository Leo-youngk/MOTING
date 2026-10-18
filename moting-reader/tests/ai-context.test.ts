import assert from "node:assert/strict";
import test from "node:test";
import { bookAiMessages, bookContext } from "../lib/ai-context.ts";
import { AI_REQUEST_LIMITS } from "../lib/ai.ts";
import type { AiChatTurn, Book, Chapter } from "../lib/types.ts";

const padding = "山路蜿蜒穿过树林，旅人沿着河流走向村庄。".repeat(500);
function chapter(id: string, title: string, texts: string[]): Chapter {
  return { id, title, order: 0, sentenceCount: texts.length, characterCount: texts.join("").length,
    paragraphs: texts.map((text, order) => ({ id: `${id}-p${order}`, kind: "text", order,
      sentences: [{ id: `${id}-s${order}`, text, speakableText: text, order: 0 }] })) };
}
function book(chapters: Chapter[]): Book {
  return { id: "context-fixture", title: "原文动态检索样本", author: "样本作者", chapters,
    format: "txt", status: "ready", accent: "#000", createdAt: 1, updatedAt: 1, lastOpenedAt: 1,
    sentenceCount: chapters.reduce((n, c) => n + c.sentenceCount, 0),
    characterCount: chapters.reduce((n, c) => n + c.characterCount, 0),
    chapterOutline: chapters.map(({ id, title, sentenceCount, characterCount }) => ({ id, title, sentenceCount, characterCount })) };
}
const ask = (content: string, quote?: string): AiChatTurn[] => [{ role: "user", content, ...(quote ? { quote } : {}) }];

test("a short book sends all imported chapters, including the ending", () => {
  const sample = book([chapter("a", "开篇", ["最初的定义。"]), chapter("b", "结尾", ["最后的限定条件。"])]);
  const context = bookContext(sample, ask("全书主要在讲什么？"), "a");
  assert.match(context, /完整正文/);
  assert.match(context, /最初的定义/);
  assert.match(context, /最后的限定条件/);
});

test("each new question searches the whole long book, not just the open chapter", () => {
  const sample = book([
    chapter("a", "第一章 山林", [padding]),
    chapter("b", "第二章 海洋", [padding, "蓝鲸依靠肺呼吸，必须定期浮出水面换气。", padding]),
    chapter("c", "第三章 沙漠", [padding, "骆驼的驼峰主要储存脂肪，并不是储水容器。", padding]),
  ]);
  const whale = bookContext(sample, ask("蓝鲸如何呼吸？"), "a");
  const camel = bookContext(sample, ask("骆驼的驼峰储存的是什么？"), "a");
  assert.match(whale, /蓝鲸依靠肺呼吸/);
  assert.match(camel, /驼峰主要储存脂肪/);
  assert.doesNotMatch(camel, /蓝鲸依靠肺呼吸/);
});

test("a selection after the old 6000-character cutoff includes the surrounding cause and qualifier", () => {
  const sample = book([chapter("a", "论证", [padding, "前提是这个实验没有外部干扰。", "结果只适用于封闭系统。", "如果有外部干扰，上述结论便不能成立。", padding])]);
  const context = bookContext(sample, ask("这段话是什么意思？", "结果只适用于封闭系统。"), "a");
  assert.match(context, /前提是这个实验没有外部干扰/);
  assert.match(context, /如果有外部干扰，上述结论便不能成立/);
});

test("selection matching tolerates whitespace and paragraph breaks", () => {
  const sample = book([chapter("a", "正文", [padding, "原因是物质没有消失。", "所以这里说的是转化。", "转化并不意味着凭空产生。", padding])]);
  const context = bookContext(sample, ask("解释一下", "原因是物质没有消失。所以这里说的是转化。"), "a");
  assert.match(context, /转化并不意味着凭空产生/);
});

test("an ambiguous follow-up retrieves the previous topic from the original text", () => {
  const sample = book([chapter("a", "山林", [padding]), chapter("b", "海洋", [padding, "蓝鲸依靠肺呼吸，必须定期浮出水面换气。", padding])]);
  const history: AiChatTurn[] = [...ask("蓝鲸如何呼吸？"), { role: "assistant", content: "蓝鲸需要浮出水面。" }, ...ask("为什么？")];
  assert.match(bookContext(sample, history, "a"), /蓝鲸依靠肺呼吸/);
});

test("named chapter requests override the open chapter and an old selection", () => {
  const sample = book([chapter("a", "第一章 山林", [padding, "旧问题的选段。"]), chapter("b", "第二章 海洋", [padding, "蓝鲸必须浮出水面。", padding])]);
  const history: AiChatTurn[] = [...ask("解释这段", "旧问题的选段。"), { role: "assistant", content: "旧问题的解释。" }, ...ask("讲讲第2章")];
  const context = bookContext(sample, history, "a");
  assert.match(context, /蓝鲸必须浮出水面/);
  assert.doesNotMatch(context, /旧问题的选段/);
});

test("cross-chapter comparisons include both chapters and their conclusions", () => {
  const sample = book([
    chapter("a", "第一章 前提", ["开篇假设A。", padding, "第一章的最终限定A。"]),
    chapter("b", "第二章 转折", [padding]),
    chapter("c", "第三章 结论", ["开篇假设C。", padding, "第三章的最终限定C。"]),
  ]);
  const context = bookContext(sample, ask("第一章和第三章的观点有什么区别？"), "b");
  assert.match(context, /最终限定A/);
  assert.match(context, /最终限定C/);
});

test("a chapter request also covers EPUB continuation sections", () => {
  const sample = book([chapter("a", "第一章 山林", [padding]), chapter("b", "第二章 海洋", ["鲸类的基本特征。"]), chapter("c", "Unknown", ["续页补充：蓝鲸必须浮出水面呼吸。"]), chapter("d", "第三章", [padding])]);
  assert.match(bookContext(sample, ask("讲讲第二章"), "a"), /续页补充：蓝鲸必须浮出水面呼吸/);
});

test("Chinese chapter numbers and the last chapter are resolved", () => {
  const chapters = Array.from({ length: 12 }, (_, i) => chapter(`c${i}`, `主题${i + 1}`, [padding, `这一章的独有结论编号${i + 1}。`]));
  const sample = book(chapters);
  assert.match(bookContext(sample, ask("第十二章讲了什么？"), "c0"), /独有结论编号12/);
  assert.match(bookContext(sample, ask("最后一章的结论是什么？")), /独有结论编号12/);
});

test("whole-book questions sample beginnings, middles and endings across chapters", () => {
  const sample = book([chapter("a", "开篇", ["开篇的起点A。", padding, "开篇的终点A。"]), chapter("b", "结尾", ["结尾的起点B。", padding, "结尾的终点B。"])]);
  const context = bookContext(sample, ask("整本书的主要论证结构是什么？"));
  for (const text of ["开篇的起点A", "开篇的终点A", "结尾的起点B", "结尾的终点B"]) assert.ok(context.includes(text));
  assert.match(context, /节选，不等于已提供全书/);
});

test("history-entry conversations have full-book access even without a current chapter", () => {
  const sample = book([chapter("a", "山林", [padding]), chapter("b", "海洋", [padding, "蓝鲸依靠肺呼吸。", padding])]);
  assert.match(bookAiMessages({ book: sample, history: ask("蓝鲸如何呼吸？") })[0].content, /蓝鲸依靠肺呼吸/);
});

test("English text is retrieved case-insensitively and English mode keeps Chinese explanations", () => {
  const sample = book([chapter("a", "Background", ["The traveller followed the winding road through a quiet forest. ".repeat(500)]), chapter("b", "Whales", ["BLUE WHALES breathe air using lungs and must return to the surface."])]);
  const messages = bookAiMessages({ book: sample, history: ask("How do blue whales breathe?"), englishMode: true });
  assert.match(messages[0].content, /BLUE WHALES breathe air/);
  assert.match(messages[0].content, /英文内容用中文讲解/);
});

test("the complete request stays within Worker limits and preserves the newest question", () => {
  const sample = book(Array.from({ length: 90 }, (_, i) => chapter(`c${i}`, `章节${i} ${"长标题".repeat(80)}`, [padding])));
  const history: AiChatTurn[] = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "历史内容".repeat(600) }));
  history.push({ role: "user", content: "我最新的问题是蓝鲸如何呼吸？", quote: "长选段".repeat(10000) });
  const messages = bookAiMessages({ book: sample, history });
  assert.ok(messages.length <= AI_REQUEST_LIMITS.messages);
  assert.ok(messages.every(m => m.content.length <= AI_REQUEST_LIMITS.messageChars));
  assert.ok(messages.reduce((n, m) => n + m.content.length, 0) <= AI_REQUEST_LIMITS.totalChars);
  assert.match(messages.at(-1)!.content, /我最新的问题是蓝鲸如何呼吸？/);
  assert.match(messages[0].content, /无需溯源列表/);
});

test("index reuse does not leak another book and a changed chapter array rebuilds the index", () => {
  const first = book([chapter("a", "正文", [padding, "蓝鲸依靠肺呼吸。"])]);
  const second = book([chapter("a", "正文", [padding, "蓝鲸改写后的新原文。"])]);
  assert.match(bookContext(first, ask("蓝鲸")), /蓝鲸依靠肺呼吸/);
  const updated = bookContext(second, ask("蓝鲸"));
  assert.match(updated, /蓝鲸改写后的新原文/);
  assert.doesNotMatch(updated, /蓝鲸依靠肺呼吸/);
});

test("missing extracted text is reported to the model instead of implying a complete book", () => {
  assert.match(bookContext(book([chapter("a", "只有标题", [])]), ask("主要讲什么？")), /尚未提取到正文/);
});
