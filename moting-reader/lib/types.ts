export type BookFormat = "epub" | "pdf" | "txt" | "md" | "demo";

export type BookStatus = "ready" | "parsing" | "error";

export type MainView = "home" | "library" | "listen" | "notes";

export type AppView =
  | { name: MainView }
  | { name: "book-notes"; bookId: string }
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
  /**
   * 仅 image 使用，图片的原始像素宽高。
   * 图片是异步从图片库取的，有了它才能在拿到图之前就把版面占住，
   * 否则图片一到就把下方正文整体推走，正在读的位置也跟着窜。
   */
  imageWidth?: number;
  imageHeight?: number;
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

export type NoteKind = "highlight" | "listening-mark";

/** 划线颜色，取值对应 CSS 里 --mark-* 那组变量。 */
export type HighlightColor = "yellow" | "green" | "blue" | "pink";

export interface BookNote {
  id: string;
  bookId: string;
  chapterId: string;
  sentenceId: string;
  kind: NoteKind;
  excerpt: string;
  createdAt: number;
  /** 划线在这句话里的字符区间，缺省表示整句。 */
  start?: number;
  end?: number;
  color?: HighlightColor;
  /** 用户为这条划线写的想法。 */
  thought?: string;
  /**
   * 一次跨句划线会按句拆成多条记录，同组共用这个 id。
   * 改色、写想法、删除都按组整体生效，用户看到的才是一整条线。
   * 旧数据没有这个字段，取不到时退回 id 本身当单元素组。
   */
  groupId?: string;
}

export type ReaderTheme = "paper" | "white" | "night";

/** 外壳（主页 / 书库 / tab bar）的底色，跟阅读器主题完全独立：
 *  换书架不动阅读器，换阅读器不动书架。 */
export type ShellTheme = "white" | "black" | "cream";

/** scroll = 上下滑动连续阅读，page = 左右翻页分页阅读。 */
export type ReadingMode = "scroll" | "page";

export interface ReaderSettings {
  fontSize: number;
  lineHeight: number;
  contentWidth: number;
  /** serif=宋体 sans=黑体 kai=楷体 yuan=圆体，四款都走 iOS 自带 CJK 系统字体，零下载。 */
  fontFamily: "serif" | "sans" | "kai" | "yuan";
  theme: ReaderTheme;
  shellTheme: ShellTheme;
  readingMode: ReadingMode;
  speechRate: number;
  voiceURI: string;
  /** 用户自带的 OpenAI 兼容接口地址，例如 https://api.deepseek.com/v1。 */
  aiBaseUrl: string;
  /** 请求经我们的 Worker 转发（绕开跨域限制），密钥随请求过一次服务器，不落盘。 */
  aiApiKey: string;
  aiModel: string;
  aiDeepThinking: boolean;
}

export interface AiChatTurn {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  /** 触发这轮提问时选中的原文片段，只在换了新片段的那一轮才有值。 */
  quote?: string;
}

/** 一本书一条常驻对话，不按划线片段拆分，随书本身持久化。 */
export interface BookAiChat {
  bookId: string;
  turns: AiChatTurn[];
  updatedAt: number;
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
  shellTheme: "white",
  readingMode: "scroll",
  speechRate: 1,
  voiceURI: "",
  aiBaseUrl: "",
  aiApiKey: "",
  aiModel: "",
  aiDeepThinking: false,
};

/** 每天的阅读秒数，键是本地时区的 YYYY-MM-DD。 */
export interface ReadingStats {
  days: Record<string, number>;
  goalMinutes: number;
}

export const DEFAULT_STATS: ReadingStats = {
  days: {},
  goalMinutes: 20,
};

/** 统计按本地日期归档，不能用 toISOString（那是 UTC，会把深夜阅读算到前一天）。 */
export function dayKey(time: number): string {
  const date = new Date(time);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
