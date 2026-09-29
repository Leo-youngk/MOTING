import { flattenChapter } from "./content.ts";
import type { Chapter } from "./types.ts";

/**
 * 云健在 1× 下连标点每秒读几个字。2026-09-29 拿线上 /api/tts 量了三段中文，
 * 按 MP3 时长折算是 4.61–4.74，取中间。
 */
const CJK_CHARS_PER_SECOND = 4.65;
/** 英文、数字按字母算，读得比汉字快得多。 */
const LATIN_CHARS_PER_SECOND = 15;

/** 一句话在 1× 下大约要读几秒。 */
export function speechSeconds(text: string): number {
  if (!text) return 0;
  const latin = text.match(/[A-Za-z0-9]/g)?.length ?? 0;
  return latin / LATIN_CHARS_PER_SECOND + (text.length - latin) / CJK_CHARS_PER_SECOND;
}

/**
 * 听书页的一「章」：目录里的一项。章名是占位词的续页并进前一章，跟目录保持一致，
 * 不然时长会在续页那里莫名其妙归零重来。
 *
 * 时间都按 1× 算，显示时再除以倍速。
 */
export interface ListenChapter {
  /** 这一项从第几章到第几章（闭区间）。 */
  first: number;
  last: number;
  /** 每一句从第几秒开始读；比句子多一项，最后一项就是全章时长。 */
  starts: number[];
  /** starts 里第 i 项对应的章句。 */
  sentences: Array<{ chapterIndex: number; sentenceIndex: number }>;
}

export function listenChapter(
  chapters: readonly Chapter[],
  first: number,
  last: number
): ListenChapter {
  const starts = [0];
  const sentences: ListenChapter["sentences"] = [];
  let seconds = 0;
  for (let chapterIndex = first; chapterIndex <= last; chapterIndex++) {
    const chapter = chapters[chapterIndex];
    if (!chapter) continue;
    flattenChapter(chapter).forEach((sentence, sentenceIndex) => {
      seconds += speechSeconds(sentence.speakableText || sentence.text);
      sentences.push({ chapterIndex, sentenceIndex });
      starts.push(seconds);
    });
  }
  return { first, last, starts, sentences };
}

export function chapterDuration(chapter: ListenChapter): number {
  return chapter.starts[chapter.starts.length - 1];
}

/** 这一句在本章第几秒开始、第几秒读完。不在本章里的位置按章首算。 */
export function sentenceSeconds(
  chapter: ListenChapter,
  chapterIndex: number,
  sentenceIndex: number
): { start: number; end: number } {
  const index = chapter.sentences.findIndex(
    (item) => item.chapterIndex === chapterIndex && item.sentenceIndex === sentenceIndex
  );
  if (index < 0) return { start: 0, end: 0 };
  return { start: chapter.starts[index], end: chapter.starts[index + 1] };
}

/** secondsAt 的反方向：拖到第几秒，落在哪一句（正在读的那句，而不是下一句）。 */
export function sentenceAtSeconds(
  chapter: ListenChapter,
  seconds: number
): { chapterIndex: number; sentenceIndex: number } {
  const { starts, sentences } = chapter;
  if (!sentences.length) return { chapterIndex: chapter.first, sentenceIndex: 0 };

  let low = 0;
  let high = sentences.length - 1;
  let match = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (starts[middle] <= seconds) {
      match = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return sentences[match];
}

/** 03:21、1:02:03。 */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${String(minutes).padStart(2, "0")}:${rest}`;
}
