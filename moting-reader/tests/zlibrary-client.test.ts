import assert from "node:assert/strict";
import test from "node:test";
import { downloadZlibrary } from "../lib/zlibrary.ts";
import { readWithTimeout } from "../lib/fetch-utils.ts";
import type { OnlineBook } from "../lib/zlibrary-types.ts";

const book: OnlineBook = { id: "17", hash: "aa", title: "下载测试", author: "", extension: "txt", language: "", year: "", bytes: null, size: "", cover: "" };
const encode = (text: string) => new TextEncoder().encode(text);

test("client verifies byte count and limits progress updates for many small chunks", async (t) => {
  let chunks = 0;
  const data = new ReadableStream<Uint8Array>({ pull(c) { if (chunks++ < 1000) c.enqueue(encode("a")); else c.close(); } });
  t.mock.method(globalThis, "fetch", async () => new Response(data, { headers: { "x-book-size": "1000", "x-book-filename": encodeURIComponent("完成.txt") } }));
  const progress: string[] = [];
  const file = await downloadZlibrary(book, (label) => progress.push(label), new AbortController().signal);
  assert.equal(file.size, 1000);
  assert.equal(await file.text(), "a".repeat(1000));
  assert.equal(file.name, "完成.txt");
  assert.match(progress.at(-1)!, /100%/);
  assert.ok(progress.length < 20, `too many UI updates: ${progress.length}`);
});

test("client cancel after headers cancels a stalled reader immediately", async (t) => {
  const controller = new AbortController();
  let canceled = false;
  const data = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encode("prefix")); }, cancel() { canceled = true; } });
  t.mock.method(globalThis, "fetch", async () => new Response(data));
  await assert.rejects(downloadZlibrary(book, (label) => { if (label.startsWith("已下载")) controller.abort(); }, controller.signal), { name: "AbortError" });
  assert.equal(canceled, true);
});

test("client rejects partial, empty and disguised HTML downloads", async (t) => {
  for (const make of [() => new Response("partial", { headers: { "x-book-size": "99" } }), () => new Response(""), () => new Response("<html>verification</html>")]) {
    t.mock.method(globalThis, "fetch", async () => make());
    await assert.rejects(downloadZlibrary(book, () => {}, new AbortController().signal), /不完整|网页而非书籍/);
    t.mock.restoreAll();
  }
});

test("a malformed optional filename header falls back to the book filename", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("book", { headers: { "x-book-filename": "%invalid" } }));
  const file = await downloadZlibrary(book, () => {}, new AbortController().signal);
  assert.equal(file.name, "下载测试.txt");
});

test("idle read timeout cancels upstream and does not wait forever", async () => {
  let canceled = false;
  const reader = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } }).getReader();
  await assert.rejects(readWithTimeout(reader, new AbortController().signal, 5), /等待超时/);
  assert.equal(canceled, true);
  reader.releaseLock();
});

test("idle timeout resets for each chunk instead of limiting the full transfer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const reader = new ReadableStream<Uint8Array>({ start(c) { source = c; } }).getReader();
  const signal = new AbortController().signal;
  for (let index = 0; index < 10; index++) {
    const read = readWithTimeout(reader, signal, 1000);
    t.mock.timers.tick(900);
    source.enqueue(encode("chunk"));
    assert.equal((await read).done, false);
  }
  source.close();
  assert.equal((await readWithTimeout(reader, signal, 1000)).done, true);
  reader.releaseLock();
});
