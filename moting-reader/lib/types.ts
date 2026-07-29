export type BookFormat = "epub" | "pdf" | "txt" | "md" | "demo";

export type BookStatus = "ready" | "parsing" | "error";

export type MainView = "library" | "listen" | "notes" | "settings";

export type AppView =
  | { name: MainView }
  | { name: "reader"; bookId: string }
  | { name: "player"; bookId: string };

export interface Sentence {
  id: string;
  text: string;
  speakableText: string;
  order: number;
}

/** 正文里的块级结构。解析时保留，渲染和朗读都按它区分对待。 */
export type BlockKind = "text" | "heading" | "quote" | "list" | "image";

export interface Paragraph {
  id: string;
  order: number;
  kind: BlockKind;
  /** 仅 heading 使用，1-6，决定渲染出的标题层级。 */
  level?: number;
  /** 仅 image 使用，指向图片库里的一条记录。 */
  imageId?: string;
  /** 仅 image 使用，替代文本，不进朗读。 */
  alt?: string;
  sentences: Sentence[];
}

/** 插图单独存一张表：书本身每次开机全量读出来，图片则按需取。 */
export interface BookImage {
  id: string;
  bookId: string;
  blob: Blob;
}

export interface Chapter {
  id: string;
  title: string;
  order: number;
  paragraphs: Paragraph[];
  sentenceCount: number;
  characterCount: number;
}

export interface BookPosition {
  chapterId: string;
  chapterIndex: number;
  sentenceId: string;
  sentenceIndex: number;
  percent: number;
  updatedAt: number;
}

export interface Book {
  id: string;
  title: string;
  author: string;
  format: BookFormat;
  fileName?: string;
  coverDataUrl?: string;
  accent: string;
  status: BookStatus;
  statusMessage?: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  chapters: Chapter[];
  sentenceCount: number;
  characterCount: number;
  readingPosition?: BookPosition;
  listeningPosition?: BookPosition;
}

export type NoteKind = "bookmark" | "listening-mark";

export interface BookNote {
  id: string;
  bookId: string;
  chapterId: string;
  sentenceId: string;
  kind: NoteKind;
  excerpt: string;
  createdAt: number;
}

export type ReaderTheme = "paper" | "white" | "night";

/** scroll = 上下滑动连续阅读，page = 左右翻页分页阅读。 */
export type ReadingMode = "scroll" | "page";

export interface ReaderSettings {
  fontSize: number;
  lineHeight: number;
  contentWidth: number;
  fontFamily: "serif" | "sans";
  theme: ReaderTheme;
  readingMode: ReadingMode;
  speechRate: number;
  voiceURI: string;
}

export interface ImportProgress {
  stage: "reading" | "metadata" | "content" | "saving";
  label: string;
  percent: number;
}

export interface SpeechSpan {
  sentenceId: string;
  sentenceIndex: number;
  start: number;
  end: number;
}

export interface SpeechBlock {
  text: string;
  spans: SpeechSpan[];
}

export interface SpeechBoundary {
  /** 该词在音频中的起始秒数。 */
  time: number;
  /** 该词在朗读文本中的起始字符下标。 */
  charIndex: number;
}

/** 播放器对外暴露的音色，既可能是云端音色也可能是设备自带语音。 */
export interface PlayerVoice {
  voiceURI: string;
  name: string;
  lang: string;
}

export interface SpeechLocation {
  bookId: string;
  chapterIndex: number;
  sentenceIndex: number;
  sentenceId: string;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 19,
  lineHeight: 1.9,
  contentWidth: 720,
  fontFamily: "serif",
  theme: "paper",
  readingMode: "scroll",
  speechRate: 1,
  voiceURI: "",
};
