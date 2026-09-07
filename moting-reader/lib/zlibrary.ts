import { ONLINE_BOOK_MAX_BYTES, type OnlineBook, type OnlineSearchResult, type ZlibrarySession } from "./zlibrary-types";

export class ZlibraryError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "ZlibraryError";
  }
}

async function request(action: string, body: object, signal?: AbortSignal): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`/api/zlibrary/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(action === "download" ? 180_000 : 40_000), ...(signal ? [signal] : [])]),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ZlibraryError("连接超时或网络不可用，请稍后重试", 503);
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ZlibraryError(typeof data?.error === "string" ? data.error : `找书服务返回 ${response.status}，请稍后重试`, response.status);
  }
  return response;
}

export async function getZlibrarySession(signal?: AbortSignal): Promise<ZlibrarySession> {
  return (await request("session", {}, signal)).json();
}

export async function loginZlibrary(email: string, password: string, signal?: AbortSignal): Promise<ZlibrarySession> {
  return (await request("login", { email, password }, signal)).json();
}

export async function logoutZlibrary(): Promise<void> {
  await request("logout", {});
}

export async function searchZlibrary(query: string, page: number, format: string, signal?: AbortSignal): Promise<OnlineSearchResult> {
  return (await request("search", { query, page, format }, signal)).json();
}

export async function downloadZlibrary(book: OnlineBook, onProgress: (label: string) => void, signal: AbortSignal): Promise<File> {
  onProgress("正在获取下载地址…");
  const response = await request("download", { id: book.id, hash: book.hash }, signal);
  if (!response.body) throw new Error("下载没有返回文件，请重试");
  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > ONLINE_BOOK_MAX_BYTES) throw new Error("文件超过 80 MB，暂时无法导入");
      chunks.push(new Uint8Array(value));
      onProgress(total ? `正在下载 ${Math.min(100, Math.round(received / total * 100))}%` : `已下载 ${(received / 1024 / 1024).toFixed(1)} MB`);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (signal.aborted) throw error;
    throw new Error(error instanceof Error && error.message.includes("80 MB") ? error.message : "下载中断，文件尚未加入书库，请重试");
  } finally {
    reader.releaseLock();
  }
  if (!received || (total && received !== total)) throw new Error("文件下载不完整，请重试");
  const encoded = response.headers.get("x-book-filename");
  const filename = encoded ? decodeURIComponent(encoded) : `${book.title}.${book.extension}`;
  const file = new File(chunks, filename, { type: response.headers.get("content-type") || "application/octet-stream" });
  const prefix = await file.slice(0, 512).text();
  if (/^\s*(?:<!doctype\s+html|<html|<head|<body)/i.test(prefix)) throw new Error("下载返回了网页而非书籍文件，请重新登录后重试");
  return file;
}
