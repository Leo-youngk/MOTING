import { MAX_BOOK_FILE_BYTES } from "./file-limits.ts";

export const ZLIBRARY_ORIGIN = "https://zh.z-lib.gd";
export const ONLINE_BOOK_MAX_BYTES = MAX_BOOK_FILE_BYTES;
export const ONLINE_BOOK_FORMATS = ["epub", "pdf", "txt", "md"] as const;

export interface OnlineBook {
  id: string;
  hash: string;
  title: string;
  author: string;
  extension: string;
  language: string;
  year: string;
  size: string;
  bytes: number | null;
  cover: string;
}

export interface OnlineSearchResult {
  books: OnlineBook[];
  page: number;
  hasMore: boolean;
}

export interface ZlibrarySession {
  connected: boolean;
}
