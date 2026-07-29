import type { SpeechBoundary, SpeechSpan } from "./types";

export const TICKS_PER_SECOND = 10000000;

export interface WordBoundary {
  /** 100 纳秒为单位的起始偏移。 */
  offset: number;
  duration: number;
  text: string;
}

/**
 * 朗读服务只给出每个词的文本和时间偏移，不给字符下标。
 * 按词序在原文里顺序推进匹配，还原出「秒数 → 字符下标」的时间轴。
 */
export function buildBoundaryTimeline(
  text: string,
  words: WordBoundary[]
): SpeechBoundary[] {
  const timeline: SpeechBoundary[] = [];
  let cursor = 0;

  for (const word of words) {
    // 数字、符号会被服务端读成别的写法，匹配不上就退回游标，保证时间轴单调。
    const found = word.text ? text.indexOf(word.text, cursor) : -1;
    const charIndex = found >= 0 ? found : cursor;
    if (found >= 0) cursor = found + word.text.length;

    timeline.push({ time: word.offset / TICKS_PER_SECOND, charIndex });
  }

  return timeline;
}

/** 二分查到当前播放秒数对应的字符下标。 */
export function charIndexAt(
  timeline: SpeechBoundary[],
  seconds: number
): number {
  if (!timeline.length) return 0;

  let low = 0;
  let high = timeline.length - 1;
  let match = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (timeline[middle].time <= seconds) {
      match = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return timeline[match].charIndex;
}

/** 找出字符下标落在哪个句子上。 */
export function spanAt(spans: SpeechSpan[], charIndex: number): SpeechSpan {
  let match = spans[0];
  for (const span of spans) {
    if (span.start <= charIndex) match = span;
    else break;
  }
  return match;
}
