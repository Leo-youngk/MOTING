export const ZLIBRARY_ORIGIN = "https://zh.z-lib.gd";
export const ONLINE_BOOK_MAX_BYTES = 80 * 1024 * 1024;
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
