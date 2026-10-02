import {
  buildEdgeSpeechBatches,
  buildSpeechBlocks,
  sliceSpeechBlock,
  flattenChapter,
  MAX_EDGE_SPEECH_BATCH_LENGTH,
} from "./content.ts";
import type { Book, Chapter, SpeechBlock, SpeechSpan } from "./types.ts";

export type SpeechEngine = "edge" | "system";

export interface BookSpeechSpan extends SpeechSpan { chapterIndex: number }
export interface BookSpeechBlock extends SpeechBlock { spans: BookSpeechSpan[] }

/** One media resource may contain several chapters; chapter boundaries only move the highlight. */
export function segmentFromBook(
  book: Book, chapterIndex: number, sentenceIndex: number,
  engine: SpeechEngine, quick: boolean, crossChapter = true
): BookSpeechBlock | null {
  const chapter = book.chapters[chapterIndex];
  if (!chapter) return null;
  if (engine === "system" || !crossChapter) {
    const part = segmentFromChapter(chapter, sentenceIndex, engine, quick);
    return part ? { ...part, spans: part.spans.map(span => ({ ...span, chapterIndex })) } : null;
  }
  const limit = quick ? QUICK_SPEECH_LENGTH : MAX_EDGE_SPEECH_BATCH_LENGTH;
  let text = "";
  const spans: BookSpeechSpan[] = [];
  outer: for (let ci = chapterIndex; ci < book.chapters.length; ci++) {
    const sentences = flattenChapter(book.chapters[ci]);
    for (let si = ci === chapterIndex ? Math.max(0, sentenceIndex) : 0; si < sentences.length; si++) {
      const sentence = sentences[si];
      const spoken = (sentence.speakableText || sentence.text).trim();
      if (!spoken) continue;
      const separator = text ? "\n" : "";
      // Keep sentences whole, including a single sentence longer than the normal budget.
      if (text && text.length + separator.length + spoken.length > limit) break outer;
      const start = text.length + separator.length;
      text += separator + spoken;
      spans.push({ chapterIndex: ci, sentenceIndex: si, sentenceId: sentence.id, start, end: text.length });
    }
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
  quick: boolean
): SpeechBlock | null {
  const blocks =
    engine === "edge"
      ? buildEdgeSpeechBatches(chapter, quick ? QUICK_SPEECH_LENGTH : undefined)
      : buildSpeechBlocks(chapter);
  return speechSegmentAt(blocks, sentenceIndex);
}
