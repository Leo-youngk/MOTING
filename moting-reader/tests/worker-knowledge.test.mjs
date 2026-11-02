import assert from "node:assert/strict";
import test from "node:test";
import worker from "../dist/server/index.js";

test("built Worker exposes the Bot API without falling through to the app", async () => {
  const openapi = await worker.fetch(new Request("https://moting.example/api/knowledge/v1/openapi.json"), {}, {});
  assert.equal(openapi.status, 200);
  assert.match(openapi.headers.get("content-type"), /application\/json/);
  const spec = await openapi.json();
  assert.equal(spec.openapi, "3.1.0");
  assert.ok(spec.paths["/notes"]);
  assert.ok(spec.paths["/chats/{bookId}"]);

  const env = { DB: {}, BOOKS_BUCKET: {} };
  for (const path of ["/api/knowledge/v1", "/api/knowledge/v1/books", "/api/knowledge/v1/notes", "/api/sync/access-keys"]) {
    const response = await worker.fetch(new Request(`https://moting.example${path}`), env, {});
    assert.equal(response.status, 401, path);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const write = await worker.fetch(new Request("https://moting.example/api/knowledge/v1/notes", { method: "POST" }), env, {});
  assert.equal(write.status, 405);
  assert.equal(write.headers.get("allow"), "GET");
});

test("built legacy Worker forwards the Bot path and Bearer credentials to the main deployment", async () => {
  const originalFetch = globalThis.fetch;
  const token = "moting_ro_" + "x".repeat(43);
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), "https://main.example/api/knowledge/v1/notes?limit=1");
    assert.equal(init.headers.get("authorization"), `Bearer ${token}`);
    return Response.json({ data: [], nextCursor: null });
  };
  try {
    const response = await worker.fetch(new Request("https://legacy.example/api/knowledge/v1/notes?limit=1", {
      headers: { authorization: `Bearer ${token}` },
    }), { SYNC_UPSTREAM: "https://main.example" }, {});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: [], nextCursor: null });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
