import { speechSeparator } from "./content.ts";
import { isPlaceholderTitle } from "./display-title.ts";
import {
  CHAPTER_SEPARATOR,
  HEADING_SEPARATOR,
  PARAGRAPH_SEPARATOR,
} from "./speech-batch.ts";
import type { Chapter, Sentence, SpeechReplacement } from "./types.ts";

/**
 * 送去合成的文字带上结构：同一段里的句子直接接上（英文补空格），换段一个换行，
 * 标题前后两个，换章三个。Worker 据此切片、在拼接处留不同长短的停顿
 * （见 lib/speech-batch.ts 的 BREAK_GAP_SECONDS）。没有标点的标题后面跟着换行，
 * Edge 也会像句末一样停一下，不会把「第一章 风起」跟正文连着念。
 */
export interface SpokenSentence {
  chapterIndex: number;
  /** 章内下标，跟 flattenChapter 的顺序一致。 */
  sentenceIndex: number;
  sentence: Sentence;
  /** 读音纠正之后、送去合成的文字。 */
  text: string;
  /** 跟前一句之间的分隔；第一句是空串。 */
  separator: string;
}

/**
 * 读音替换：长的规则先替换，免得「长大」被「长」抢先。纯字面替换，不认正则。
 * 同样的规则每次给出同样的文本，缓存键才对得上。
 */
export function speechReplacer(
  rules: readonly SpeechReplacement[] | undefined
): (text: string) => string {
  const usable = (rules ?? [])
    .filter((rule) => rule.from.trim() && rule.from !== rule.to)
    .slice()
    .sort((a, b) => b.from.length - a.from.length);
  if (!usable.length) return (text) => text;
  return (text) => {
    let result = text;
    for (const rule of usable) result = result.split(rule.from).join(rule.to);
    return result;
  };
}

/** 规则的签名，进各种缓存键：规则变了，同一位置要合成的就是另一段文字。 */
export function replacementKey(rules: readonly SpeechReplacement[] | undefined): string {
  return rules?.length ? JSON.stringify(rules.map((rule) => [rule.from, rule.to])) : "";
}

/**
 * 从某一句开始，按书里的顺序逐句给出要读的文字和它前面的分隔。读出来是空的句子跳过。
 * crossChapter=false 时只给这一章的。章名是「未知」这类占位词的章是上一章的续页，按换段算。
 */
export function* spokenSentences(
  chapters: readonly Chapter[],
  chapterIndex: number,
  sentenceIndex: number,
  speak: (text: string) => string = (text) => text,
  crossChapter = true
): Generator<SpokenSentence> {
  let previous: { text: string; heading: boolean; chapterIndex: number; paragraph: number } | null = null;
  for (let ci = Math.max(0, chapterIndex); ci < chapters.length; ci += 1) {
    if (!crossChapter && ci !== chapterIndex) return;
    const chapter = chapters[ci];
    let index = 0;
    for (const [paragraphIndex, paragraph] of (chapter.paragraphs ?? []).entries()) {
      const heading = paragraph.kind === "heading";
      for (const sentence of paragraph.sentences) {
        const current = index;
        index += 1;
        if (ci === chapterIndex && current < sentenceIndex) continue;
        const text = speak(sentence.speakableText || sentence.text).trim();
        if (!text) continue;
        let separator = "";
        if (previous) {
          if (previous.chapterIndex !== ci) {
            separator = isPlaceholderTitle(chapter.title)
              ? heading || previous.heading ? HEADING_SEPARATOR : PARAGRAPH_SEPARATOR
              : CHAPTER_SEPARATOR;
          } else if (previous.paragraph !== paragraphIndex) {
            separator = heading || previous.heading ? HEADING_SEPARATOR : PARAGRAPH_SEPARATOR;
          } else {
            separator = speechSeparator(previous.text, text);
          }
        }
        yield { chapterIndex: ci, sentenceIndex: current, sentence, text, separator };
        previous = { text, heading, chapterIndex: ci, paragraph: paragraphIndex };
      }
    }
  }
}
