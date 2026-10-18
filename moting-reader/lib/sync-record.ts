/** 大记录与逐条确认协议。正文按内容哈希保存，D1 只保留不可变对象的引用。 */
export const RECORD_PROTOCOL = 5;
export const INLINE_RECORD_BYTES = 256 * 1024;
export const MAX_RECORD_BYTES = 32 * 1024 * 1024;
export const STORED_BLOB_PREFIX = "@moting-sync-r2-v1:";

export type RecordKind = "books" | "notes" | "sessions" | "settings" | "chats" | "patches";
export interface RecordBlob { hash: string; bytes: number }
export interface RecordReceipt {
  kind: RecordKind;
  key: string;
  updatedAt: number;
  status: "accepted" | "stale";
  serverAt: number;
}
export interface RecordIssue {
  kind: RecordKind | "positions" | "listening";
  key: string;
  updatedAt: number;
  code: string;
  reason: string;
  bytes: number;
  retryable: boolean;
}
export interface PushFailure extends RecordIssue {
  fingerprint: string;
  protocol: number;
  attempts: number;
  retryAt: number;
}
export const RECORD_LABELS: Record<RecordIssue["kind"], string> = {
  books: "书籍资料", notes: "笔记", sessions: "阅读记录", settings: "设置",
  chats: "AI 对话", patches: "书籍资料补丁", positions: "阅读进度", listening: "听书进度",
};
export function utf8Bytes(text: string): number { return new TextEncoder().encode(text).byteLength; }
export async function recordHash(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}
export function isRecordBlob(value: unknown): value is RecordBlob {
  if (!value || typeof value !== "object") return false;
  const blob = value as RecordBlob;
  return typeof blob.hash === "string" && /^[a-f0-9]{64}$/.test(blob.hash) &&
    Number.isSafeInteger(blob.bytes) && blob.bytes > 0 && blob.bytes <= MAX_RECORD_BYTES;
}
export function storedBlob(text: string): RecordBlob | null {
  if (!text.startsWith(STORED_BLOB_PREFIX)) return null;
  try { const blob: unknown = JSON.parse(text.slice(STORED_BLOB_PREFIX.length)); return isRecordBlob(blob) ? blob : null; }
  catch { return null; }
}
export function recordObjectKey(kind: string, key: string, hash: string): string {
  return `sync-records/v1/${kind}/${key}/${hash}.json`;
}
export function recordPath(kind: string, key: string, hash: string): string {
  return `/api/sync/record/${encodeURIComponent(kind)}/${encodeURIComponent(key)}/${hash}`;
}
export function retryDelay(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 5), 15 * 60_000);
}

export function retryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 425 || status === 429;
}
