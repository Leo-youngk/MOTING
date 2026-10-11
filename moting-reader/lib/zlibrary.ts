import { MAX_BOOK_FILE_ERROR, MAX_BOOK_FILE_LABEL } from "./file-limits.ts";
import { fetchWithTimeout, readWithTimeout } from "./fetch-utils.ts";
import { ONLINE_BOOK_MAX_BYTES, type OnlineBook, type OnlineSearchResult, type ZlibrarySession } from "./zlibrary-types.ts";

export class ZlibraryError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ZlibraryError";
    this.status = status;
  }
}

async function request(action: string, body: object, signal?: AbortSignal): Promise<Response> {
  let response: Response;
  try {
    response = await fetchWithTimeout(`/api/zlibrary/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify(body),
      signal,
    }, action === "download" ? 75_000 : 40_000);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ZlibraryError("连接超时或网络不可用，请稍后重试", 503);
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    const error = typeof data === "object" && data !== null && "error" in data && typeof data.error === "string"
      ? data.error
      : `找书服务返回 ${response.status}，请稍后重试`;
    throw new ZlibraryError(error, response.status);
  }
  return response;
}

export async function getZlibrarySession(signal?: AbortSignal): Promise<ZlibrarySession> {
  return (await request("session", {}, signal)).json();
}

export async function loginZlibrary(email: string, password: string, signal?: AbortSignal): Promise<ZlibrarySession> {
  return (await request("login", { email, password }, signal)).json();
}

export async function logoutZlibrary(signal?: AbortSignal): Promise<void> {
  await request("logout", {}, signal);
}

export async function searchZlibrary(query: string, page: number, signal?: AbortSignal): Promise<OnlineSearchResult> {
  return (await request("search", { query, page }, signal)).json();
}

export async function downloadZlibrary(book: OnlineBook, onProgress: (label: string) => void, signal: AbortSignal): Promise<File> {
  onProgress("正在获取下载地址…");
  const response = await request("download", { id: book.id, hash: book.hash }, signal);
  if (!response.body) throw new Error("下载没有返回文件，请重试");
  const total = Number(response.headers.get("x-book-size") || response.headers.get("content-length")) || 0;
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let received = 0;
  let lastProgressAt = 0;
  try {
    while (true) {
      const { done, value } = await readWithTimeout(reader, signal, 60_000);
      if (done) break;
      received += value.byteLength;
      if (received > ONLINE_BOOK_MAX_BYTES) throw new Error(MAX_BOOK_FILE_ERROR);
      chunks.push(value as Uint8Array<ArrayBuffer>);
      const now = Date.now();
      if (now - lastProgressAt >= 150 || received === total) {
        lastProgressAt = now;
        onProgress(total ? `正在下载 ${Math.min(100, Math.round(received / total * 100))}%` : `已下载 ${(received / 1024 / 1024).toFixed(1)} MB`);
      }
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (signal.aborted) throw error;
    throw new Error(error instanceof Error && error.message.includes(MAX_BOOK_FILE_LABEL) ? error.message : "下载中断，文件尚未加入书库，请重试");
  } finally {
    reader.releaseLock();
  }
  if (!received || (total && received !== total)) throw new Error("文件下载不完整，请重试");
  signal.throwIfAborted();
  const encoded = response.headers.get("x-book-filename");
  let filename = `${book.title}.${book.extension}`;
  try { if (encoded) filename = decodeURIComponent(encoded); } catch { /* 无效文件名不影响下载。 */ }
  const file = new File(chunks, filename, { type: response.headers.get("content-type") || "application/octet-stream" });
  const prefix = await file.slice(0, 512).text();
  if (/^\s*(?:<!doctype\s+html|<html|<head|<body)/i.test(prefix)) throw new Error("下载返回了网页而非书籍文件，请重新登录后重试");
  return file;
}
