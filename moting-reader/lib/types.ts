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

export interface Paragraph {
  id: string;
  order: number;
  sentences: Sentence[];
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

export interface ReaderSettings {
  fontSize: number;
  lineHeight: number;
  contentWidth: number;
  fontFamily: "serif" | "sans";
  theme: ReaderTheme;
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
  speechRate: 1,
  voiceURI: "",
};
