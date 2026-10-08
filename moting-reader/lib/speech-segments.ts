import {
  buildEdgeSpeechBatches,
  buildSpeechBlocks,
  sliceSpeechBlock,
  flattenChapter,
  MAX_EDGE_SPEECH_BATCH_LENGTH,
} from "./content.ts";
import { spokenSentences } from "./speech-text.ts";
import type { Book, Chapter, SpeechBlock, SpeechSpan } from "./types.ts";

export type SpeechEngine = "edge" | "system";

export interface BookSpeechSpan extends SpeechSpan { chapterIndex: number }
export interface BookSpeechBlock extends SpeechBlock { spans: BookSpeechSpan[] }

/**
 * 云端一段读多长：0 档是点下去之后的首段（360 字，三四秒出声），1 档是第二段（1500 字，
 * 首段一开播就去合成，十来秒就好），之后是 2 档长批次（4800 字，读十几分钟）。
 * 以前首段读完直接接 4800 字，长批次要整批合成完才回来（实测 40–48 秒），
 * 首段往往撑不到那时候，起播半分钟左右必卡一次。
 */
export type SpeechTier = 0 | 1 | 2;
export const TIER_LENGTH: Record<SpeechTier, number> = { 0: 360, 1: 1500, 2: MAX_EDGE_SPEECH_BATCH_LENGTH };

export function nextTier(tier: SpeechTier): SpeechTier {
  return tier === 0 ? 1 : 2;
}

/**
 * One media resource may contain several chapters; chapter boundaries only move the highlight.
 * quick 可以是老的布尔值（true 首段、false 长批次），也可以直接给档位。
 * 云端文字带结构（换段、标题、换章的换行），段尾带上跟下一句之间的换行，Worker 据此决定
 * 这一批读完之后停多久；speak 是读音纠正。
 */
export function segmentFromBook(
  book: Book, chapterIndex: number, sentenceIndex: number,
  engine: SpeechEngine, quick: boolean | SpeechTier, crossChapter = true,
  speak: (text: string) => string = (text) => text
): BookSpeechBlock | null {
  const chapter = book.chapters[chapterIndex];
  if (!chapter) return null;
  const tier: SpeechTier = quick === true ? 0 : quick === false ? 2 : quick;
  if (engine === "system") {
    const part = segmentFromChapter(chapter, sentenceIndex, engine, tier === 0, speak);
    return part ? { ...part, spans: part.spans.map(span => ({ ...span, chapterIndex })) } : null;
  }
  const limit = TIER_LENGTH[tier];
  let text = "";
  const spans: BookSpeechSpan[] = [];
  for (const item of spokenSentences(book.chapters, chapterIndex, sentenceIndex, speak, crossChapter)) {
    const separator = spans.length ? item.separator : "";
    // Keep sentences whole, including a single sentence longer than the normal budget.
    if (spans.length && text.length + separator.length + item.text.length > limit) {
      if (item.separator.startsWith("\n")) text += item.separator;
      break;
    }
    text += separator;
    const start = text.length;
    text += item.text;
    spans.push({ chapterIndex: item.chapterIndex, sentenceIndex: item.sentenceIndex, sentenceId: item.sentence.id, start, end: text.length });
  }
  return spans.length ? { text, spans } : null;
}

export function spanForBookSentence(part: BookSpeechBlock, chapterIndex: number, sentenceIndex: number): BookSpeechSpan | null {
  return part.spans.find(span => span.chapterIndex === chapterIndex && span.sentenceIndex === sentenceIndex) ?? null;
}

/** Find the next real sentence without recursion through image-only / empty chapters. */
export function nextBookSentence(book: Book, chapterIndex: number, sentenceIndex: number): { chapterIndex: number; sentenceIndex: number } | null {
  for (let ci = Math.max(0, chapterIndex); ci < book.chapters.length; ci++) {
    const sentences = flattenChapter(book.chapters[ci]);
    for (let si = ci === chapterIndex ? Math.max(0, sentenceIndex) : 0; si < sentences.length; si++) {
      if ((sentences[si].speakableText || sentences[si].text).trim()) return { chapterIndex: ci, sentenceIndex: si };
    }
  }
  return null;
}

/**
 * 点击后的首段刻意短：云端合成耗时基本跟字数走，360 字通常一轮分片就回来了。
 * 起播、换音色、跳位置都用它，连续播放再换成长批次。
 */
export const QUICK_SPEECH_LENGTH = 360;

/**
 * 从这一章的朗读块里取出「从第 sentenceIndex 句开始」的那一段。
 *
 * 起始句落在块中间时要裁掉前半截并重算偏移，否则会把用户已经听过的内容重读一遍；
 * 裁完只剩空白（整块都在起始句之前）就顺延到下一块。
 */
export function speechSegmentAt(
  blocks: SpeechBlock[],
  sentenceIndex: number
): SpeechBlock | null {
  let index = blocks.findIndex(
    (block) => block.spans[block.spans.length - 1].sentenceIndex >= sentenceIndex
  );
  if (index < 0) return null;

  let segment = sliceSpeechBlock(blocks[index], sentenceIndex);
  while (!segment.text.trim() && index + 1 < blocks.length) {
    index += 1;
    segment = blocks[index];
  }
  return segment.text.trim() ? segment : null;
}

/** 这一段读完之后该接哪一句。 */
export function sentenceAfter(segment: SpeechBlock): number {
  return segment.spans[segment.spans.length - 1].sentenceIndex + 1;
}

/** 这一段里第 sentenceIndex 句从哪个字符开始；这一段不含这句就是 null。 */
export function spanForSentence(
  segment: SpeechBlock,
  sentenceIndex: number
): SpeechSpan | null {
  return (
    segment.spans.find((span) => span.sentenceIndex === sentenceIndex) ?? null
  );
}

/**
 * 直接从章节取一段。quick=true 给短首段，false 给长批次。
 *
 * 长批次只在云端有意义：一条长媒体资源交给系统媒体管线连续播放，退到后台
 * 也不用每几十秒唤醒 JS 换源。系统朗读走的是 utterance，几千字塞不进去。
 */
export function segmentFromChapter(
  chapter: Chapter,
  sentenceIndex: number,
  engine: SpeechEngine,
  quick: boolean,
  speak: (text: string) => string = (text) => text
): SpeechBlock | null {
  const blocks =
    engine === "edge"
      ? buildEdgeSpeechBatches(chapter, quick ? QUICK_SPEECH_LENGTH : undefined)
      : buildSpeechBlocks(chapter, speak);
  return speechSegmentAt(blocks, sentenceIndex);
}
