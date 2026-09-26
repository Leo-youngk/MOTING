import { COVER_IMAGE_ID } from "./sync-merge.ts";

export interface PendingImage { bookId: string; imageId: string }
interface RecoveryDeps {
  getBook(bookId: string): Promise<{ coverDataUrl?: string } | undefined>;
  getImage(imageId: string): Promise<{ bookId: string } | undefined>;
  download(bookId: string, imageId: string): Promise<Blob | null>;
  toDataUrl(blob: Blob): Promise<string>;
  saveCover(bookId: string, dataUrl: string): Promise<boolean>;
  saveImage(image: { id: string; bookId: string; blob: Blob }): Promise<boolean>;
}

/** 成功落盘后才能从重试队列移除；网络和存储失败由调用方留待下轮。 */
export async function recoverPendingImage(entry: PendingImage, deps: RecoveryDeps): Promise<"books" | "images" | null> {
  const book = await deps.getBook(entry.bookId);
  if (!book) return null;
  const cover = entry.imageId === COVER_IMAGE_ID;
  if (cover ? book.coverDataUrl : (await deps.getImage(entry.imageId))?.bookId === entry.bookId) return null;
  const blob = await deps.download(entry.bookId, entry.imageId);
  if (!blob) return null;
  if (cover) {
    return await deps.saveCover(entry.bookId, await deps.toDataUrl(blob)) ? "books" : null;
  }
  return await deps.saveImage({ id: entry.imageId, bookId: entry.bookId, blob }) ? "images" : null;
}
