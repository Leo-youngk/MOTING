import assert from "node:assert/strict";
import test from "node:test";
import { recoverPendingImage } from "../lib/sync-images.ts";

function setup() {
  const books = new Map<string, { coverDataUrl?: string }>([["A", {}], ["B", {}]]);
  // 旧版本留下的 _cover 不应阻止任何一本书恢复自己的封面。
  const images = new Map([["_cover", { bookId: "wrong-book" }]]);
  const deps = {
    async getBook(id: string) { return books.get(id); },
    async getImage(id: string) { return images.get(id); },
    async download(bookId: string) { return new Blob([bookId]); },
    async toDataUrl(blob: Blob) { return "data:image/png;base64," + btoa(await blob.text()); },
    async saveCover(id: string, coverDataUrl: string) {
      const book = books.get(id);
      if (!book || book.coverDataUrl) return false;
      books.set(id, { coverDataUrl });
      return true;
    },
    async saveImage(image: { id: string; bookId: string; blob: Blob }) { images.set(image.id, image); return true; },
  };
  return { books, images, deps };
}

test("failed covers recover independently into their book metadata and request bookshelf refresh", async () => {
  const { books, images, deps } = setup();
  for (const bookId of ["A", "B"]) assert.equal(await recoverPendingImage({ bookId, imageId: "_cover" }, deps), "books");
  assert.equal(books.get("A")?.coverDataUrl, "data:image/png;base64,QQ==");
  assert.equal(books.get("B")?.coverDataUrl, "data:image/png;base64,Qg==");
  assert.equal(images.get("_cover")?.bookId, "wrong-book");
});

test("recovery preserves a cover changed during download and does not resurrect deleted books", async () => {
  const { books, deps } = setup();
  deps.download = async (id) => { books.set(id, { coverDataUrl: "user-cover" }); return new Blob([id]); };
  assert.equal(await recoverPendingImage({ bookId: "A", imageId: "_cover" }, deps), null);
  assert.equal(books.get("A")?.coverDataUrl, "user-cover");
  deps.download = async (id) => { books.delete(id); return new Blob([id]); };
  assert.equal(await recoverPendingImage({ bookId: "B", imageId: "_cover" }, deps), null);
  assert.equal(books.has("B"), false);
});

test("image recovery propagates download and persistence failures for retry", async () => {
  const { deps, images } = setup();
  deps.download = async () => { throw new Error("offline"); };
  await assert.rejects(recoverPendingImage({ bookId: "A", imageId: "_cover" }, deps), /offline/);
  deps.download = async () => new Blob(["image"]);
  deps.saveImage = async () => { throw new Error("quota"); };
  await assert.rejects(recoverPendingImage({ bookId: "A", imageId: "illustration" }, deps), /quota/);
  assert.equal(images.has("illustration"), false);
});

test("ordinary recovered illustrations are persisted and already present images are not downloaded again", async () => {
  const { deps, images } = setup();
  assert.equal(await recoverPendingImage({ bookId: "A", imageId: "illustration" }, deps), "images");
  assert.equal(images.get("illustration")?.bookId, "A");
  deps.download = async () => { throw new Error("must not fetch again"); };
  assert.equal(await recoverPendingImage({ bookId: "A", imageId: "illustration" }, deps), null);
});
