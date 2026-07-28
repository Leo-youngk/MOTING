import type {
  Book,
  BookFormat,
  BookPosition,
  Chapter,
  Paragraph,
  Sentence,
} from "./types";

const ACCENTS = ["#718091", "#85766b", "#788271", "#8b6e64", "#6f7d87"];

export function makeId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

export function normalizeWhitespace(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[\t\f\v]+/g, " ")
    .replace(/ {2,}/g, " ")
    .replace(/\s+([，。！？；：、,.!?;:])/g, "$1")
    .trim();
}

export function toSpeakableText(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/\[(\d+|注\d*)\]/g, "")
      .replace(/\((见|参见).{0,18}?\)/g, "")
      .replace(/https?:\/\/[^\s，。！？；：、]+/g, "链接")
      .replace(/[*_`#>|]/g, "")
  );
}

export function splitIntoSentences(value: string): string[] {
  const clean = normalizeWhitespace(value);
  if (!clean) return [];

  const matches =
    clean.match(
      /[^。！？!?；;…]+(?:[。！？!?；;]+|…{1,2}|$)|[。！？!?；;…]+/g
    ) ?? [clean];

  const sentences: string[] = [];
  for (const raw of matches) {
    const sentence = normalizeWhitespace(raw);
    if (!sentence) continue;
    if (sentence.length <= 1 && /^[。！？!?；;…]$/.test(sentence)) {
      if (sentences.length) {
        sentences[sentences.length - 1] += sentence;
      }
      continue;
    }
    sentences.push(sentence);
  }

  return sentences.length ? sentences : [clean];
}

export function createParagraph(text: string, order: number): Paragraph | null {
  const sentenceTexts = splitIntoSentences(text);
  if (!sentenceTexts.length) return null;

  const sentences: Sentence[] = sentenceTexts.map((sentence, sentenceOrder) => ({
    id: makeId("sentence"),
    text: sentence,
    speakableText: toSpeakableText(sentence),
    order: sentenceOrder,
  }));

  return {
    id: makeId("paragraph"),
    order,
    sentences,
  };
}

export function createChapter(
  title: string,
  paragraphTexts: string[],
  order: number
): Chapter | null {
  const paragraphs = paragraphTexts
    .map((text, paragraphOrder) => createParagraph(text, paragraphOrder))
    .filter((paragraph): paragraph is Paragraph => Boolean(paragraph));

  if (!paragraphs.length) return null;

  const sentences = paragraphs.flatMap((paragraph) => paragraph.sentences);
  return {
    id: makeId("chapter"),
    title: normalizeWhitespace(title) || `第 ${order + 1} 章`,
    order,
    paragraphs,
    sentenceCount: sentences.length,
    characterCount: sentences.reduce(
      (sum, sentence) => sum + sentence.text.length,
      0
    ),
  };
}

const CHAPTER_PATTERN =
  /^(?:#{1,4}\s+.+|第[〇零一二三四五六七八九十百千万两0-9]+[章节卷部篇回]\s*.{0,40}|(?:chapter|part)\s+[\divxlcdm]+.*)$/i;

function stripHeadingMarker(value: string): string {
  return normalizeWhitespace(value.replace(/^#{1,4}\s+/, ""));
}

export function chaptersFromPlainText(
  rawText: string,
  fallbackTitle = "正文"
): Chapter[] {
  const text = rawText
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .trim();

  if (!text) return [];

  const blocks = text
    .split(/\n{2,}/)
    .map((block) => normalizeWhitespace(block.replace(/\n+/g, " ")))
    .filter(Boolean);

  const sections: Array<{ title: string; paragraphs: string[] }> = [];
  let current = { title: fallbackTitle, paragraphs: [] as string[] };

  for (const block of blocks) {
    if (CHAPTER_PATTERN.test(block) && block.length <= 64) {
      if (current.paragraphs.length) sections.push(current);
      current = { title: stripHeadingMarker(block), paragraphs: [] };
    } else {
      current.paragraphs.push(block);
    }
  }
  if (current.paragraphs.length) sections.push(current);

  if (sections.length <= 1 && blocks.join("").length > 16000) {
    const chunks: Array<{ title: string; paragraphs: string[] }> = [];
    let chunk: string[] = [];
    let length = 0;
    for (const block of blocks) {
      chunk.push(block);
      length += block.length;
      if (length >= 8000) {
        chunks.push({
          title: `${fallbackTitle} · ${chunks.length + 1}`,
          paragraphs: chunk,
        });
        chunk = [];
        length = 0;
      }
    }
    if (chunk.length) {
      chunks.push({
        title: `${fallbackTitle} · ${chunks.length + 1}`,
        paragraphs: chunk,
      });
    }
    return chunks
      .map((section, index) =>
        createChapter(section.title, section.paragraphs, index)
      )
      .filter((chapter): chapter is Chapter => Boolean(chapter));
  }

  return sections
    .map((section, index) =>
      createChapter(section.title, section.paragraphs, index)
    )
    .filter((chapter): chapter is Chapter => Boolean(chapter));
}

export function createBook(input: {
  title: string;
  author?: string;
  format: BookFormat;
  chapters: Chapter[];
  fileName?: string;
  coverDataUrl?: string;
}): Book {
  const now = Date.now();
  return {
    id: makeId("book"),
    title: normalizeWhitespace(input.title) || "未命名书籍",
    author: normalizeWhitespace(input.author ?? "") || "未知作者",
    format: input.format,
    fileName: input.fileName,
    coverDataUrl: input.coverDataUrl,
    accent: ACCENTS[Math.floor(Math.random() * ACCENTS.length)],
    status: "ready",
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    chapters: input.chapters,
    sentenceCount: input.chapters.reduce(
      (sum, chapter) => sum + chapter.sentenceCount,
      0
    ),
    characterCount: input.chapters.reduce(
      (sum, chapter) => sum + chapter.characterCount,
      0
    ),
  };
}

export function flattenChapter(chapter: Chapter): Sentence[] {
  return chapter.paragraphs.flatMap((paragraph) => paragraph.sentences);
}

export function findSentence(
  book: Book,
  sentenceId?: string
): { chapterIndex: number; sentenceIndex: number; sentence: Sentence } | null {
  if (!sentenceId) return null;
  for (let chapterIndex = 0; chapterIndex < book.chapters.length; chapterIndex++) {
    const sentences = flattenChapter(book.chapters[chapterIndex]);
    const sentenceIndex = sentences.findIndex(
      (sentence) => sentence.id === sentenceId
    );
    if (sentenceIndex >= 0) {
      return { chapterIndex, sentenceIndex, sentence: sentences[sentenceIndex] };
    }
  }
  return null;
}

export function positionFor(
  book: Book,
  chapterIndex: number,
  sentenceIndex: number
): BookPosition {
  const safeChapterIndex = Math.max(
    0,
    Math.min(chapterIndex, book.chapters.length - 1)
  );
  const chapter = book.chapters[safeChapterIndex];
  const sentences = flattenChapter(chapter);
  const safeSentenceIndex = Math.max(
    0,
    Math.min(sentenceIndex, Math.max(sentences.length - 1, 0))
  );
  const sentence = sentences[safeSentenceIndex];

  const completedBefore = book.chapters
    .slice(0, safeChapterIndex)
    .reduce((sum, item) => sum + item.sentenceCount, 0);
  const completed = completedBefore + safeSentenceIndex;
  const percent =
    book.sentenceCount > 1
      ? Math.round((completed / (book.sentenceCount - 1)) * 100)
      : 0;

  return {
    chapterId: chapter.id,
    chapterIndex: safeChapterIndex,
    sentenceId: sentence?.id ?? "",
    sentenceIndex: safeSentenceIndex,
    percent: Math.max(0, Math.min(100, percent)),
    updatedAt: Date.now(),
  };
}

export function initialPosition(book: Book): BookPosition {
  return positionFor(book, 0, 0);
}

export function movePosition(
  book: Book,
  chapterIndex: number,
  sentenceIndex: number,
  delta: number
): BookPosition {
  let nextChapter = chapterIndex;
  let nextSentence = sentenceIndex + delta;

  while (nextChapter >= 0 && nextChapter < book.chapters.length) {
    const sentences = flattenChapter(book.chapters[nextChapter]);
    if (nextSentence >= 0 && nextSentence < sentences.length) {
      return positionFor(book, nextChapter, nextSentence);
    }
    if (nextSentence >= sentences.length) {
      nextSentence -= sentences.length;
      nextChapter += 1;
    } else {
      nextChapter -= 1;
      if (nextChapter >= 0) {
        nextSentence += flattenChapter(book.chapters[nextChapter]).length;
      }
    }
  }

  if (nextChapter < 0) return positionFor(book, 0, 0);
  const lastChapterIndex = book.chapters.length - 1;
  return positionFor(
    book,
    lastChapterIndex,
    Math.max(flattenChapter(book.chapters[lastChapterIndex]).length - 1, 0)
  );
}

export function formatReadingTime(characterCount: number): string {
  const minutes = Math.max(1, Math.round(characterCount / 320));
  if (minutes < 60) return `约 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `约 ${hours} 小时 ${rest} 分钟` : `约 ${hours} 小时`;
}
