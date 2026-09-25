import type {
  BlockKind,
  Book,
  BookFormat,
  BookMeta,
  BookPosition,
  Chapter,
  ChapterOutline,
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

/**
 * 一章的规模上限。超过任一条就得再切开。
 *
 * 连续阅读靠章节窗口（一次只挂 CHAPTER_WINDOW 章）把 DOM 规模摁住，前提是「一章」
 * 本身不能太大。实测《白鹿原》整本 47 万字落在一个 EPUB 文件里、被当成一章时，
 * 正文一次性挂出 1616 段 / 15819 个句子 span，滚动掉到 4fps；按标题切开后是 141fps。
 */
const MAX_CHAPTER_CHARACTERS = 8000;
const MAX_CHAPTER_BLOCKS = 200;

export interface BlockSection {
  title: string;
  blocks: BlockInput[];
}

function sectionSize(blocks: BlockInput[]): { chars: number; count: number } {
  return {
    chars: blocks.reduce((sum, block) => sum + block.text.length, 0),
    count: blocks.length,
  };
}

function oversized(blocks: BlockInput[]): boolean {
  const { chars, count } = sectionSize(blocks);
  return chars > MAX_CHAPTER_CHARACTERS || count > MAX_CHAPTER_BLOCKS;
}

/** 连标题都没有、还是太长的，只能按规模硬切，至少保证单章挂得动。 */
function splitOversized(section: BlockSection): BlockSection[] {
  if (!oversized(section.blocks)) return [section];

  const parts: BlockSection[] = [];
  let chunk: BlockInput[] = [];
  for (const block of section.blocks) {
    chunk.push(block);
    if (oversized(chunk)) {
      parts.push({ title: `${section.title} · ${parts.length + 1}`, blocks: chunk });
      chunk = [];
    }
  }
  if (chunk.length) {
    parts.push({ title: `${section.title} · ${parts.length + 1}`, blocks: chunk });
  }
  return parts;
}

/**
 * 把一个文件解析出来的块切成若干章。
 *
 * EPUB 里「一个 spine 文件 = 一章」只是常见情况，不是规矩：实测《白鹿原》整本正文
 * 都在 chapter001.xhtml 里，原书的 34 章是文件内部的 34 个 `<h2>`。所以文件规模正常时
 * 原样返回（多数书本来就一文件一章，章内的 h2 是小节标题，拆开只会把目录搞碎），
 * 只有明显超标的文件才按标题切。
 *
 * 切的时候只认最浅的那一级标题：h2 和 h3 混排时 h3 是章内小标题，不该各自成章。
 */
export function splitBlocksIntoSections(
  blocks: BlockInput[],
  fallbackTitle: string
): BlockSection[] {
  if (!blocks.length) return [];
  if (!oversized(blocks)) return [{ title: fallbackTitle, blocks }];

  const levels = blocks
    .filter((block) => block.kind === "heading")
    .map((block) => block.level ?? 3);
  const splitLevel = levels.length ? Math.min(...levels) : 0;

  const sections: BlockSection[] = [];
  let current: BlockSection = { title: fallbackTitle, blocks: [] };

  for (const block of blocks) {
    const startsChapter =
      splitLevel > 0 &&
      block.kind === "heading" &&
      (block.level ?? 3) === splitLevel &&
      Boolean(block.text.trim());
    if (startsChapter) {
      if (current.blocks.length) sections.push(current);
      // 标题本身变成章名，不再作为正文段落重复一遍。
      current = { title: block.text, blocks: [] };
      continue;
    }
    current.blocks.push(block);
  }
  if (current.blocks.length) sections.push(current);

  return sections.flatMap(splitOversized);
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
    chapterOutline: outlineOf(input.chapters),
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

/** 从正文算出目录。书目里存的就是它，正文改了（导入、同步下载）必须跟着重算。 */
export function outlineOf(chapters: Chapter[]): ChapterOutline[] {
  return chapters.map((chapter) => ({
    id: chapter.id,
    title: chapter.title,
    sentenceCount: chapter.sentenceCount,
    characterCount: chapter.characterCount,
  }));
}

export function flattenChapter(chapter: Chapter): Sentence[] {
  return chapter.paragraphs.flatMap((paragraph) => paragraph.sentences);
}

const MAX_SPEECH_BLOCK_LENGTH = 240;
export const MAX_EDGE_SPEECH_BATCH_LENGTH = 4800;

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

/**
 * 云端语音会在 Worker 内部安全分片再拼回一条 MP3，因此客户端可以跨段落合成
 * 一个长媒体资源。退到后台后由系统媒体管线连续播放，不必每几十秒唤醒 JS 换源。
 */
export function buildEdgeSpeechBatches(
  chapter: Chapter,
  maxLength = MAX_EDGE_SPEECH_BATCH_LENGTH
): SpeechBlock[] {
  const blocks: SpeechBlock[] = [];
  let text = "";
  let spans: SpeechSpan[] = [];
  let sentenceIndex = 0;

  const flush = () => {
    if (spans.length && text.trim()) blocks.push({ text, spans });
    text = "";
    spans = [];
  };

  for (const paragraph of chapter.paragraphs) {
    for (const sentence of paragraph.sentences) {
      const speakable = sentence.speakableText || sentence.text;
      if (text && text.length + speakable.length > maxLength) flush();
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
  }

  flush();
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

/**
 * positionFor 的反方向：进度条拖到百分之几，落在哪一章哪一句。
 * 进度按句子数算（跟 positionFor 同一把尺子），所以拖到 37% 再读出来还是 37%。
 */
export function positionAtPercent(book: Book, percent: number): BookPosition {
  const clamped = Math.max(0, Math.min(100, percent));
  let target = Math.round((clamped / 100) * Math.max(book.sentenceCount - 1, 0));
  for (let chapterIndex = 0; chapterIndex < book.chapters.length; chapterIndex++) {
    const count = book.chapters[chapterIndex].sentenceCount;
    if (target < count) return positionFor(book, chapterIndex, target);
    target -= count;
  }
  // 走到这里只可能是浮点误差让下标多出一点点：落在最后一句（positionFor 会把下标收回来）。
  return positionFor(book, book.chapters.length - 1, Number.MAX_SAFE_INTEGER);
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
  book: Pick<BookMeta, "characterCount" | "chapterOutline">,
  position?: BookPosition
): number {
  if (!position) return book.characterCount;
  const chapter = book.chapterOutline[position.chapterIndex];
  if (!chapter) return book.characterCount;
  const consumed = chapter.sentenceCount
    ? chapter.characterCount * (position.sentenceIndex / chapter.sentenceCount)
    : 0;
  const later = book.chapterOutline
    .slice(position.chapterIndex + 1)
    .reduce((sum, item) => sum + item.characterCount, 0);
  return Math.max(0, Math.round(chapter.characterCount - consumed + later));
}

/** 首页那句「剩余 2 小时 14 分」。已经读完就直接说读完。 */
export function formatRemaining(
  book: Pick<BookMeta, "characterCount" | "chapterOutline">,
  position?: BookPosition
): string {
  if (!position) return `${formatReadingTime(book.characterCount)}读完`;
  if (position.percent >= 99) return "已读完";
  return `剩余${formatReadingTime(remainingCharacters(book, position))}`;
}

/** 全书页码模型：按当前排版估算每章起止页，供目录与页脚显示绝对页码。 */
export interface BookPagination {
  chapterStart: number[];
  chapterPages: number[];
  total: number;
}

/** 按当前排版，一行大约能放几个汉字。正文栏宽跟 .reader-article 的宽度规则一致。 */
export function charsPerLine(
  layout: { fontSize: number; contentWidth: number },
  viewportWidth: number
): number {
  const columnWidth = Math.max(
    120,
    Math.min(viewportWidth - 42, layout.contentWidth)
  );
  return Math.max(8, Math.floor(columnWidth / layout.fontSize));
}

export function estimatePagination(
  book: Pick<BookMeta, "chapterOutline">,
  layout: { fontSize: number; lineHeight: number; contentWidth: number },
  viewport: { width: number; height: number }
): BookPagination {
  const perLine = charsPerLine(layout, viewport.width);
  const usableHeight = Math.max(200, viewport.height - 132);
  const lines = Math.max(
    6,
    Math.floor(usableHeight / (layout.fontSize * layout.lineHeight))
  );
  const perPage = Math.max(1, perLine * lines);

  const chapterStart: number[] = [];
  const chapterPages: number[] = [];
  let cursor = 1;
  for (const chapter of book.chapterOutline) {
    chapterStart.push(cursor);
    const pages = Math.max(
      1,
      Math.ceil((chapter.characterCount || 1) / perPage)
    );
    chapterPages.push(pages);
    cursor += pages;
  }
  return { chapterStart, chapterPages, total: Math.max(1, cursor - 1) };
}

/** 某阅读位置对应的绝对页码（1 起）。 */
export function pageAt(
  pagination: BookPagination,
  chapterIndex: number,
  sentenceIndex: number,
  sentenceCount: number
): number {
  const start = pagination.chapterStart[chapterIndex] ?? 1;
  const pages = pagination.chapterPages[chapterIndex] ?? 1;
  const fraction =
    sentenceCount > 0
      ? Math.min(1, Math.max(0, sentenceIndex / sentenceCount))
      : 0;
  return Math.min(pagination.total, start + Math.floor(fraction * pages));
}
