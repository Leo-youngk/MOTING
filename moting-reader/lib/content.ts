import type {
  BlockKind,
  Book,
  BookFormat,
  BookPosition,
  Chapter,
  Paragraph,
  Sentence,
  SpeechBlock,
  SpeechSpan,
} from "./types";

/** 解析器交给内容层的块，`kind` 省略时按正文处理。 */
export interface BlockInput {
  text: string;
  kind?: BlockKind;
  level?: number;
  imageId?: string;
  alt?: string;
  imageWidth?: number;
  imageHeight?: number;
}

/** 读出图片的原始宽高，解不出来（比如 SVG）就当没有，渲染时退回自适应。 */
export async function imageSize(
  blob: Blob
): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size.width > 0 && size.height > 0 ? size : null;
  } catch {
    return null;
  }
}

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

/** 单句上限。云端 TTS 一次最多收 400 字，留出余量后按这个数切。 */
const MAX_SENTENCE_LENGTH = 180;

/**
 * 逗号句读长的段落（尤其是 PDF/TXT 导入）会出现整段没有句号的情况，
 * 一句话超过云端 TTS 的字数上限就整段读不出来，这里先按次级标点、再按硬长度切开。
 */
function splitLongSentence(sentence: string): string[] {
  if (sentence.length <= MAX_SENTENCE_LENGTH) return [sentence];

  const pieces: string[] = [];
  let buffer = "";
  for (const part of sentence.match(/[^，,、：:]+[，,、：:]*/g) ?? [sentence]) {
    if (buffer && buffer.length + part.length > MAX_SENTENCE_LENGTH) {
      pieces.push(buffer);
      buffer = "";
    }
    buffer += part;
    // 单个逗号短语本身就超长时只能按字数硬切。
    while (buffer.length > MAX_SENTENCE_LENGTH) {
      pieces.push(buffer.slice(0, MAX_SENTENCE_LENGTH));
      buffer = buffer.slice(MAX_SENTENCE_LENGTH);
    }
  }
  if (buffer) pieces.push(buffer);
  return pieces;
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
    sentences.push(...splitLongSentence(sentence));
  }

  return sentences.length ? sentences : splitLongSentence(clean);
}

export function createParagraph(
  block: BlockInput,
  order: number
): Paragraph | null {
  if (block.kind === "image") {
    if (!block.imageId) return null;
    const paragraph: Paragraph = {
      id: makeId("paragraph"),
      order,
      kind: "image",
      imageId: block.imageId,
      alt: normalizeWhitespace(block.alt ?? ""),
      sentences: [],
    };
    if (block.imageWidth && block.imageHeight) {
      paragraph.imageWidth = block.imageWidth;
      paragraph.imageHeight = block.imageHeight;
    }
    return paragraph;
  }

  const sentenceTexts = splitIntoSentences(block.text);
  if (!sentenceTexts.length) return null;

  const sentences: Sentence[] = sentenceTexts.map((sentence, sentenceOrder) => ({
    id: makeId("sentence"),
    text: sentence,
    speakableText: toSpeakableText(sentence),
    order: sentenceOrder,
  }));

  const paragraph: Paragraph = {
    id: makeId("paragraph"),
    order,
    kind: block.kind ?? "text",
    sentences,
  };
  if (paragraph.kind === "heading") {
    paragraph.level = Math.min(6, Math.max(1, block.level ?? 3));
  }
  return paragraph;
}

export function createChapter(
  title: string,
  blocks: BlockInput[],
  order: number
): Chapter | null {
  const paragraphs = blocks
    .map((block, paragraphOrder) => createParagraph(block, paragraphOrder))
    .filter((paragraph): paragraph is Paragraph => Boolean(paragraph));

  const sentences = paragraphs.flatMap((paragraph) => paragraph.sentences);
  // 阅读位置全靠句子下标定位，没有句子的纯插图页不能当成一章。
  if (!sentences.length) return null;

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

/** 早期导入的书没记插图尺寸，量出来之后补回正文里，只重建受影响的章节。 */
export function withImageSizes(
  book: Book,
  sizes: Map<string, { width: number; height: number }>
): Book {
  const sizeOf = (paragraph: Paragraph) =>
    paragraph.kind === "image" && !paragraph.imageHeight && paragraph.imageId
      ? sizes.get(paragraph.imageId)
      : undefined;

  return {
    ...book,
    chapters: book.chapters.map((chapter) => {
      if (!chapter.paragraphs.some(sizeOf)) return chapter;
      return {
        ...chapter,
        paragraphs: chapter.paragraphs.map((paragraph) => {
          const size = sizeOf(paragraph);
          return size
            ? { ...paragraph, imageWidth: size.width, imageHeight: size.height }
            : paragraph;
        }),
      };
    }),
  };
}

const CHAPTER_PATTERN =
  /^(?:#{1,2}\s+.+|第[〇零一二三四五六七八九十百千万两0-9]+[章卷部篇回]\s*.{0,40}|(?:chapter|part)\s+[\divxlcdm]+.*)$/i;

/** 章内小标题：不另起一章，但也不该降级成正文段落。 */
const HEADING_PATTERN =
  /^(?:#{3,6}\s+.+|第[〇零一二三四五六七八九十百千万两0-9]+[节節]\s*.{0,40})$/;

function stripHeadingMarker(value: string): string {
  return normalizeWhitespace(value.replace(/^#{1,6}\s+/, ""));
}

function headingLevelOf(value: string): number {
  return value.match(/^(#{1,6})\s/)?.[1].length ?? 3;
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

  const sections: Array<{ title: string; paragraphs: BlockInput[] }> = [];
  let current = { title: fallbackTitle, paragraphs: [] as BlockInput[] };

  for (const block of blocks) {
    if (CHAPTER_PATTERN.test(block) && block.length <= 64) {
      if (current.paragraphs.length) sections.push(current);
      current = { title: stripHeadingMarker(block), paragraphs: [] };
    } else if (HEADING_PATTERN.test(block) && block.length <= 64) {
      current.paragraphs.push({
        kind: "heading",
        level: headingLevelOf(block),
        text: stripHeadingMarker(block),
      });
    } else {
      current.paragraphs.push({ text: block });
    }
  }
  if (current.paragraphs.length) sections.push(current);

  if (sections.length <= 1 && blocks.join("").length > 16000) {
    const chunks: Array<{ title: string; paragraphs: BlockInput[] }> = [];
    let chunk: BlockInput[] = [];
    let length = 0;
    for (const block of sections[0]?.paragraphs ?? []) {
      chunk.push(block);
      length += block.text.length;
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

const MAX_SPEECH_BLOCK_LENGTH = 240;

export function buildSpeechBlocks(chapter: Chapter): SpeechBlock[] {
  const blocks: SpeechBlock[] = [];
  let sentenceIndex = 0;

  for (const paragraph of chapter.paragraphs) {
    let text = "";
    let spans: SpeechSpan[] = [];

    const flush = () => {
      if (spans.length && text.trim()) blocks.push({ text, spans });
      text = "";
      spans = [];
    };

    for (const sentence of paragraph.sentences) {
      const speakable = sentence.speakableText || sentence.text;
      if (text && text.length + speakable.length > MAX_SPEECH_BLOCK_LENGTH) {
        flush();
      }
      const separator =
        !text || /[。！？!?；;…，,、.]$/.test(text) ? "" : " ";
      const start = text.length + separator.length;
      text += separator + speakable;
      spans.push({
        sentenceId: sentence.id,
        sentenceIndex,
        start,
        end: text.length,
      });
      sentenceIndex += 1;
    }

    flush();
  }

  return blocks;
}

export function sliceSpeechBlock(
  block: SpeechBlock,
  fromSentenceIndex: number
): SpeechBlock {
  const spanIndex = block.spans.findIndex(
    (span) => span.sentenceIndex >= fromSentenceIndex
  );
  if (spanIndex <= 0) return block;

  const offset = block.spans[spanIndex].start;
  return {
    text: block.text.slice(offset),
    spans: block.spans.slice(spanIndex).map((span) => ({
      ...span,
      start: span.start - offset,
      end: span.end - offset,
    })),
  };
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

/** 连续滚动时同时挂在 DOM 里的那一段章节，闭区间。 */
export interface ChapterRange {
  start: number;
  end: number;
}

/**
 * 正文两端的哨兵进入缓冲区后，算出下一次该挂哪几章。
 *
 * 摘章有个不显然的前提：被摘掉的那一章必须整个退到缓冲区之外。否则补偿完滚动位置，
 * 另一头的哨兵会立刻进区，于是接一章、摘一章来回抖。所以这里要拿两端章节的实际
 * 位置来判断，光看挂了几章是不够的。
 */
export function nextChapterRange(
  current: ChapterRange,
  input: {
    lastChapter: number;
    hitStart: boolean;
    hitEnd: boolean;
    /** 窗口首章相对视口的下边缘，取不到时给 null，表示不确定、别摘。 */
    firstBottom: number | null;
    /** 窗口末章相对视口的上边缘。 */
    lastTop: number | null;
    viewportHeight: number;
    margin: number;
    windowSize: number;
  }
): ChapterRange {
  const mounted = current.end - current.start + 1;
  const full = mounted >= input.windowSize;

  if (input.hitEnd && current.end < input.lastChapter) {
    const trim =
      full && input.firstBottom !== null && input.firstBottom < -input.margin;
    return {
      start: trim ? current.start + 1 : current.start,
      end: current.end + 1,
    };
  }

  if (input.hitStart && current.start > 0) {
    const trim =
      full &&
      input.lastTop !== null &&
      input.lastTop > input.viewportHeight + input.margin;
    return {
      start: current.start - 1,
      end: trim ? current.end - 1 : current.end,
    };
  }

  return current;
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

/** 从某个位置往后还剩多少字。当前章按句子比例折算，后面的章整章计入。 */
export function remainingCharacters(
  book: Book,
  position?: BookPosition
): number {
  if (!position) return book.characterCount;
  const chapter = book.chapters[position.chapterIndex];
  if (!chapter) return book.characterCount;
  const consumed = chapter.sentenceCount
    ? chapter.characterCount * (position.sentenceIndex / chapter.sentenceCount)
    : 0;
  const later = book.chapters
    .slice(position.chapterIndex + 1)
    .reduce((sum, item) => sum + item.characterCount, 0);
  return Math.max(0, Math.round(chapter.characterCount - consumed + later));
}

/** 首页那句「剩余 2 小时 14 分」。已经读完就直接说读完。 */
export function formatRemaining(book: Book, position?: BookPosition): string {
  if (!position) return `${formatReadingTime(book.characterCount)}读完`;
  if (position.percent >= 99) return "已读完";
  return `剩余${formatReadingTime(remainingCharacters(book, position))}`;
}
