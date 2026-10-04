import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { fetchWithTimeout } from "../lib/fetch-utils.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 像浏览器那样：fetch 的 signal 一断，还没读完的正文就跟着报错。 */
function serve(chunks: string[], gapMs: number, stallAfter = Infinity) {
  globalThis.fetch = async (_input, init) => {
    const signal = init?.signal ?? undefined;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        for (const [index, chunk] of chunks.entries()) {
          if (index >= stallAfter) return; // 连接卡在半路：既不再来数据，也不结束。
          await new Promise((resolve) => setTimeout(resolve, gapMs));
          if (signal?.aborted) return;
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("正文传到一半卡住，超时照样把它掐断", async () => {
  serve(['{"a":', "1}"], 5, 1);
  const started = Date.now();
  await assert.rejects(
    fetchWithTimeout("https://example.test/", {}, 60, (response) => response.json())
  );
  assert.ok(Date.now() - started < 1000);
});

test("读正文的时候外面取消，读取立刻停下", async () => {
  serve(['{"a":', "1}"], 5, 1);
  const controller = new AbortController();
  const reading = fetchWithTimeout(
    "https://example.test/",
    { signal: controller.signal },
    10_000,
    (response) => response.json()
  );
  setTimeout(() => controller.abort(new Error("用户取消")), 30);
  await assert.rejects(reading, /用户取消/);
});

test("正文一直有进展就不算超时，大文件慢慢传也能读完", async () => {
  serve(["[", "1,", "2,", "3,", "4,", "5]"], 30);
  const result = await fetchWithTimeout("https://example.test/", {}, 80, (response) => response.json());
  assert.deepEqual(result, [1, 2, 3, 4, 5]);
});
