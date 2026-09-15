import {
  buildEdgeSpeechBatches,
  buildSpeechBlocks,
  sliceSpeechBlock,
} from "./content.ts";
import type { Chapter, SpeechBlock, SpeechSpan } from "./types.ts";

export type SpeechEngine = "edge" | "system";

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
