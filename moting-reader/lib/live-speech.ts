import { flattenChapter } from "./content.ts";
import { charIndexAt, timeAt } from "./speech-timeline.ts";
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

/** A bounded session starts at the exact saved sentence and includes chapter transitions. */
export function makeLivePlan(book: Book, position: BookPosition, maxChars = 120_000): LivePlan {
  let text = "";
  const sentences: LiveSentence[] = [];
  outer: for (let chapterIndex = position.chapterIndex; chapterIndex < book.chapters.length; chapterIndex++) {
    const lines = flattenChapter(book.chapters[chapterIndex]);
    const first = chapterIndex === position.chapterIndex ? position.sentenceIndex : 0;
    for (let sentenceIndex = first; sentenceIndex < lines.length; sentenceIndex++) {
      const line = lines[sentenceIndex];
      const spoken = line.text.trim();
      if (!spoken) continue;
      if (text.length + spoken.length + 1 > maxChars) break outer;
      const start = text.length;
      text += spoken + "\n";
      sentences.push({
        bookId: book.id, chapterIndex, sentenceIndex,
        sentenceId: line.id, start, end: text.length,
      });
    }
  }
  return { text, sentences };
}

export function liveLocationAt(plan: LivePlan, status: LiveStatus, time: number): LiveSentence | null {
  if (!plan.sentences.length || !status.segments.length) return plan.sentences[0] ?? null;
  const segment = status.segments.find(part => time < part.time + part.duration)
    ?? status.segments[status.segments.length - 1];
  const local = Math.max(0, Math.min(segment.duration, time - segment.time));
  const char = segment.start + (segment.timeline.length
    ? charIndexAt(segment.timeline, local)
    : Math.floor((segment.end - segment.start) * local / segment.duration));
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
  const segment = status.segments.find(part => part.start <= sentence.start && sentence.start < part.end);
  if (!segment) return null;
  return segment.time + (segment.timeline.length
    ? timeAt(segment.timeline, sentence.start - segment.start)
    : segment.duration * (sentence.start - segment.start) / (segment.end - segment.start));
}
