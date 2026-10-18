import assert from "node:assert/strict";
import test from "node:test";
import worker from "../dist/server/index.js";

const request = () => new Request("https://reader.example/api/zlibrary/download", {
  method: "POST", headers: { "content-type": "application/json", origin: "https://reader.example" }, body: JSON.stringify({ id: "17", hash: "aa" }),
});
const env = { ASSETS: { fetch: async () => new Response("not found", { status: 404 }) } };
const ctx = { waitUntil() {}, passThroughOnException() {} };

test("compiled Worker retries CDN startup and forwards verified file size", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input) => {
    if (String(input).includes("/eapi/book/")) return Response.json({ file: { extension: "txt", downloadLink: "https://files.example/book" } });
    if (++calls === 1) return new Response(null, { status: 503 });
    return new Response("complete", { headers: { "content-length": "8" } });
  });
  const response = await worker.fetch(request(), env, ctx);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-book-size"), "8");
  assert.equal(await response.text(), "complete");
  assert.equal(calls, 2);
});

test("compiled Worker resumes a broken stream without resolving a second link", async (t) => {
  let lookups = 0;
  let files = 0;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (String(input).includes("/eapi/book/")) { lookups++; return Response.json({ file: { extension: "txt", downloadLink: "https://files.example/book" } }); }
    if (++files === 1) return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("a")); }, pull(c) { c.error(new Error("fixture disconnect")); } }), { headers: { "content-length": "3", etag: '"v1"' } });
    assert.equal(new Headers(init.headers).get("range"), "bytes=1-");
    return new Response("bc", { status: 206, headers: { "content-range": "bytes 1-2/3", etag: '"v1"' } });
  });
  const response = await worker.fetch(request(), env, ctx);
  assert.equal(await response.text(), "abc");
  assert.equal(files, 2);
  assert.equal(lookups, 1);
});
