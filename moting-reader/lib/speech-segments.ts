import { buildSpeechBlocks, sliceSpeechBlock, SPEECH_JOINED_END } from "./content.ts";
import { isPlaceholderTitle } from "./display-title.ts";
import { speechSeconds } from "./listen-clock.ts";
import {
  CHAPTER_SEPARATOR,
  HEADING_SEPARATOR,
  PARAGRAPH_SEPARATOR,
} from "./speech-batch.ts";
import type {
  Chapter,
  Sentence,
  SpeechBlock,
  SpeechReplacement,
  SpeechSpan,
} from "./types.ts";

export type SpeechEngine = "edge" | "system";

/** 全书里的一个位置。 */
export interface SpeechCursor {
  chapterIndex: number;
  sentenceIndex: number;
}

/**
 * 云端一段要读多长：
 *
 * - 0 档：点下去之后的第一段，360 字。合成细切成 3 片并发，3 秒上下出声，能读 40–80 秒。
 * - 1 档：第二段，1500 字。首段一开播就去合成，十来秒就好，远早于首段读完。
 * - 2 档：之后按全书固定的网格走，一格 4000 字左右、能读十几分钟，可以跨章。
 *
 * 以前首段读完直接接 4800 字的长批次，长批次要等整批合成完才回来，实测 40–48 秒，
 * 首段往往撑不到那时候，起播半分钟左右必卡一次。
 */
export type SpeechTier = 0 | 1 | 2;
export const TIER_LENGTH = [360, 1500] as const;

/**
 * 网格：从书的第一句起每 4000 字左右切一格。长批次对齐到网格上，不管从哪儿开始听，
 * 读上一阵之后请求的文本都一样，云端缓存、本地缓存才能复用，「离线缓存」下好的也能用上。
 * 一格读十几分钟，后台只需要这么久换一次音源——iOS 主屏应用在后台换音源并不总能成功。
 */
export const GRID_LENGTH = 4000;
/** 从格子中间开始时剩下的太短，就连下一格一起读，免得刚接上又要换。 */
export const GRID_MIN_REMAINDER = 1200;

export interface SpeechSegment extends SpeechBlock {
  tier: SpeechTier;
  /** 读完之后从哪儿接着读；null 表示全书读完。 */
  next: SpeechCursor | null;
}

interface IndexedSentence {
  chapterIndex: number;
  sentenceIndex: number;
  sentence: Sentence;
  /** 跟前一句之间的分隔：同段内是空串或空格，换段、标题、换章是换行。 */
  separator: string;
}

export interface SpeechIndex {
  sentences: IndexedSentence[];
  /** 每章第一句在 sentences 里的下标。 */
  chapterStarts: number[];
  /** 每一格从第几句开始。 */
  grid: number[];
}

const indexes = new WeakMap<readonly Chapter[], SpeechIndex>();

function rawSpeakable(sentence: Sentence): string {
  return sentence.speakableText || sentence.text;
}

/**
 * 把全书摊平成一列句子，顺便算好每句前面的分隔符和网格。按 chapters 数组缓存，
 * 正文重新读进来（数组换了）才重算。
 */
export function speechIndexFor(chapters: readonly Chapter[]): SpeechIndex {
  const cached = indexes.get(chapters);
  if (cached) return cached;

  const sentences: IndexedSentence[] = [];
  const chapterStarts: number[] = [];
  const grid: number[] = [];
  let previousText = "";
  let previousHeading = false;
  let gridChars = 0;

  chapters.forEach((chapter, chapterIndex) => {
    chapterStarts.push(sentences.length);
    let sentenceIndex = 0;
    chapter.paragraphs.forEach((paragraph, paragraphIndex) => {
      const heading = paragraph.kind === "heading";
      paragraph.sentences.forEach((sentence, order) => {
        let separator = "";
        if (sentences.length) {
          if (sentenceIndex === 0) {
            // 章名是「未知」这类占位词的，是上一章拆出来的续页，照换段算。
            separator = isPlaceholderTitle(chapter.title)
              ? heading || previousHeading
                ? HEADING_SEPARATOR
                : PARAGRAPH_SEPARATOR
              : CHAPTER_SEPARATOR;
          } else if (order === 0 && paragraphIndex > 0) {
            separator = heading || previousHeading ? HEADING_SEPARATOR : PARAGRAPH_SEPARATOR;
          } else {
            separator = SPEECH_JOINED_END.test(previousText) ? "" : " ";
          }
        }
        const text = rawSpeakable(sentence);
        const length = separator.length + text.length;
        if (!grid.length || (gridChars && gridChars + length > GRID_LENGTH)) {
          grid.push(sentences.length);
          gridChars = text.length;
        } else {
          gridChars += length;
        }
        sentences.push({ chapterIndex, sentenceIndex, sentence, separator });
        previousText = text;
        previousHeading = heading;
        sentenceIndex += 1;
      });
    });
  });

  const index = { sentences, chapterStarts, grid };
  indexes.set(chapters, index);
  return index;
}

/** 位置在全书句子列表里的下标；越界返回 -1。 */
export function ordinalOf(index: SpeechIndex, cursor: SpeechCursor): number {
  const start = index.chapterStarts[cursor.chapterIndex];
  if (start === undefined || cursor.sentenceIndex < 0) return -1;
  const end = index.chapterStarts[cursor.chapterIndex + 1] ?? index.sentences.length;
  const ordinal = start + cursor.sentenceIndex;
  return ordinal < end ? ordinal : -1;
}

export function cursorAt(index: SpeechIndex, ordinal: number): SpeechCursor | null {
  const item = index.sentences[ordinal];
  return item ? { chapterIndex: item.chapterIndex, sentenceIndex: item.sentenceIndex } : null;
}

/** 这一句所在的那一格的起点和终点（不含）。 */
function gridCellAt(index: SpeechIndex, ordinal: number): { start: number; end: number } {
  let low = 0;
  let high = index.grid.length - 1;
  let cell = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (index.grid[middle] <= ordinal) {
      cell = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return {
    start: index.grid[cell],
    end: index.grid[cell + 1] ?? index.sentences.length,
  };
}

/**
 * 读法替换：长的规则先替换，免得「长大」被「长」抢先。纯字面替换，不认正则。
 * 返回的函数要保持稳定，同样的规则每次给出同样的文本，缓存键才对得上。
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

function build(
  index: SpeechIndex,
  start: number,
  end: number,
  maxChars: number,
  tier: SpeechTier,
  speak: (text: string) => string
): SpeechSegment {
  let text = "";
  const spans: SpeechSpan[] = [];
  let ordinal = start;
  for (; ordinal < end; ordinal += 1) {
    const item = index.sentences[ordinal];
    const spoken = speak(rawSpeakable(item.sentence));
    const separator = ordinal === start ? "" : item.separator;
    if (spans.length && text.length + separator.length + spoken.length > maxChars) break;
    text += separator;
    const spanStart = text.length;
    text += spoken;
    spans.push({
      sentenceId: item.sentence.id,
      chapterIndex: item.chapterIndex,
      sentenceIndex: item.sentenceIndex,
      start: spanStart,
      end: text.length,
    });
  }
  // 段尾带上跟下一句之间的换行：Worker 据此决定这一批读完之后停多久。
  const following = index.sentences[ordinal];
  if (following && following.separator.startsWith("\n")) text += following.separator;
  return {
    text,
    spans,
    tier,
    next: cursorAt(index, ordinal),
  };
}

/**
 * 云端从 cursor 开始的那一段。0、1 档按字数截，2 档读到所在网格的末尾
 * （剩下不到 GRID_MIN_REMAINDER 就连下一格一起）。
 */
export function speechSegment(
  index: SpeechIndex,
  cursor: SpeechCursor,
  tier: SpeechTier,
  speak: (text: string) => string = (text) => text
): SpeechSegment | null {
  const start = ordinalOf(index, cursor);
  if (start < 0) return null;
  if (tier === 0 || tier === 1) {
    return build(index, start, index.sentences.length, TIER_LENGTH[tier], tier, speak);
  }

  const cell = gridCellAt(index, start);
  let end = cell.end;
  let chars = 0;
  for (let ordinal = start; ordinal < end; ordinal += 1) {
    chars += index.sentences[ordinal].separator.length + rawSpeakable(index.sentences[ordinal].sentence).length;
  }
  if (chars < GRID_MIN_REMAINDER && end < index.sentences.length) {
    end = gridCellAt(index, end).end;
  }
  return build(index, start, end, Number.POSITIVE_INFINITY, 2, speak);
}

/** cursor 所在那一整格（从格子开头起）。本地已经有这一格的音频时，直接拿它从中间播。 */
export function gridSegmentAt(
  index: SpeechIndex,
  cursor: SpeechCursor,
  speak: (text: string) => string = (text) => text
): SpeechSegment | null {
  const ordinal = ordinalOf(index, cursor);
  if (ordinal < 0) return null;
  const start = cursorAt(index, gridCellAt(index, ordinal).start);
  return start ? speechSegment(index, start, 2, speak) : null;
}

export function nextTier(tier: SpeechTier): SpeechTier {
  return tier === 0 ? 1 : 2;
}

/** 这一段里的某一句；不在这段里返回 null。 */
export function spanForSentence(
  segment: SpeechBlock,
  cursor: SpeechCursor
): SpeechSpan | null {
  return (
    segment.spans.find(
      (span) =>
        span.chapterIndex === cursor.chapterIndex &&
        span.sentenceIndex === cursor.sentenceIndex
    ) ?? null
  );
}

/**
 * 系统朗读的一块：一段一块（240 字以内），不跨章。起播句落在块中间时裁掉前半截。
 * next 指向这一块之后的那一句，可能在下一章。
 */
export function systemSegment(
  chapters: readonly Chapter[],
  cursor: SpeechCursor,
  speak: (text: string) => string = (text) => text
): SpeechSegment | null {
  const chapter = chapters[cursor.chapterIndex];
  if (!chapter) return null;
  const blocks = buildSpeechBlocks(chapter, cursor.chapterIndex, speak);
  let blockIndex = blocks.findIndex(
    (block) => block.spans[block.spans.length - 1].sentenceIndex >= cursor.sentenceIndex
  );
  if (blockIndex < 0) return null;
  let block = sliceSpeechBlock(blocks[blockIndex], cursor.sentenceIndex);
  while (!block.text.trim() && blockIndex + 1 < blocks.length) {
    blockIndex += 1;
    block = blocks[blockIndex];
  }
  if (!block.text.trim()) return null;

  const last = block.spans[block.spans.length - 1].sentenceIndex;
  let next: SpeechCursor | null =
    last + 1 < chapter.sentenceCount
      ? { chapterIndex: cursor.chapterIndex, sentenceIndex: last + 1 }
      : null;
  for (let chapterIndex = cursor.chapterIndex + 1; !next && chapterIndex < chapters.length; chapterIndex += 1) {
    if (chapters[chapterIndex].sentenceCount > 0) next = { chapterIndex, sentenceIndex: 0 };
  }
  return { ...block, tier: 0, next };
}

/**
 * 从 cursor 那一句的开头往前（seconds > 0）或往后挪大约多少秒，落在哪一句。
 * 按字数估时长，给不在当前音频里的跳转用；在当前音频里的直接按真实时间轴跳。
 */
export function cursorAfterSeconds(
  index: SpeechIndex,
  cursor: SpeechCursor,
  seconds: number
): SpeechCursor | null {
  let ordinal = ordinalOf(index, cursor);
  if (ordinal < 0) return null;
  const durationOf = (at: number) => speechSeconds(rawSpeakable(index.sentences[at].sentence));

  if (seconds >= 0) {
    let left = seconds;
    while (ordinal + 1 < index.sentences.length) {
      const length = durationOf(ordinal);
      if (left < length) break;
      left -= length;
      ordinal += 1;
    }
    return cursorAt(index, ordinal);
  }

  let left = -seconds;
  while (ordinal > 0 && left > 0) {
    ordinal -= 1;
    left -= durationOf(ordinal);
  }
  return cursorAt(index, ordinal);
}
