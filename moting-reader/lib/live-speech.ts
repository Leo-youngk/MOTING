import { charIndexAt, timeAt } from "./speech-timeline.ts";
import { spokenSentences } from "./speech-text.ts";
import type { Book, BookPosition, SpeechLocation } from "./types.ts";

export interface LiveSentence extends SpeechLocation {
  start: number;
  end: number;
}
export interface LivePlan {
  text: string;
  sentences: LiveSentence[];
}
export interface LiveSegment {
  number: number;
  start: number;
  end: number;
  duration: number;
  time: number;
  timeline: { time: number; charIndex: number }[];
}
export interface LiveStatus {
  ready: boolean;
  complete: boolean;
  duration: number;
  error?: string;
  updated: number;
  segments: LiveSegment[];
}

/**
 * A bounded session starts at the exact saved sentence and includes chapter transitions.
 * 文字带段落、标题、换章的结构（见 lib/speech-text.ts），会话按 format 2 建，
 * Worker 据此在拼接处留合适的停顿；speak 是读音纠正。
 */
export function makeLivePlan(
  book: Book,
  position: BookPosition,
  maxChars = 120_000,
  speak: (text: string) => string = (text) => text
): LivePlan {
  let text = "";
  const sentences: LiveSentence[] = [];
  for (const item of spokenSentences(book.chapters, position.chapterIndex, position.sentenceIndex, speak)) {
    const separator = sentences.length ? item.separator : "";
    if (text.length + separator.length + item.text.length > maxChars) break;
    text += separator;
    const start = text.length;
    text += item.text;
    sentences.push({
      bookId: book.id, chapterIndex: item.chapterIndex, sentenceIndex: item.sentenceIndex,
      sentenceId: item.sentence.id, start, end: text.length,
    });
  }
  return { text, sentences };
}

export function liveLocationAt(plan: LivePlan, status: LiveStatus, time: number): LiveSentence | null {
  if (!plan.sentences.length || !status.segments.length) return plan.sentences[0] ?? null;
  // 媒体的 currentTime 按微秒取整：精确跳到一句的开头时，往下舍的那一点不能让高亮落回上一句。
  const playbackTime = time + 0.0001;
  const segment = status.segments.find(part => playbackTime < part.time + part.duration)
    ?? status.segments[status.segments.length - 1];
  const local = Math.max(0, Math.min(segment.duration, playbackTime - segment.time));
  const char = segment.start + (segment.timeline.length
    ? charIndexAt(segment.timeline, local)
    : Math.floor((segment.end - segment.start) * local / segment.duration + 1e-7));
  let low = 0; let high = plan.sentences.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (plan.sentences[middle].start <= char) low = middle;
    else high = middle - 1;
  }
  return plan.sentences[low];
}

export function liveTimeFor(plan: LivePlan, status: LiveStatus, chapterIndex: number, sentenceIndex: number): number | null {
  const sentence = plan.sentences.find(part => part.chapterIndex === chapterIndex && part.sentenceIndex === sentenceIndex);
  if (!sentence) return null;
  return liveTimeAtChar(status, sentence.start);
}

export function liveTimeAtChar(status: LiveStatus, charIndex: number): number | null {
  const segment = status.segments.find(part => part.start <= charIndex && charIndex < part.end);
  if (!segment) return null;
  return segment.time + (segment.timeline.length
    ? timeAt(segment.timeline, charIndex - segment.start)
    : segment.duration * (charIndex - segment.start) / (segment.end - segment.start));
}
