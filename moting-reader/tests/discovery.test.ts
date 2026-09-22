import assert from "node:assert/strict";
import test from "node:test";
import { handleDiscovery } from "../worker/discovery.ts";

function request(path: string, method = "GET") {
  return new Request(`https://reader.example${path}`, { method });
}

function fetcher(fn: (url: URL, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return async (url, init) => fn(new URL(String(url)), init);
}

const unused = fetcher(() => { throw new Error("Unexpected upstream request"); });

test("category search selects a Chinese edition and normalizes missing metadata", async () => {
  const response = await handleDiscovery(request("/api/discovery/search?topic=literature&language=zh&page=2"), undefined, fetcher((url, init) => {
    assert.equal(url.origin, "https://openlibrary.org");
    assert.equal(url.pathname, "/search.json");
    assert.equal(url.searchParams.get("q"), "subject_key:literature language:chi");
    assert.equal(url.searchParams.get("lang"), "zh");
    assert.equal(url.searchParams.get("page"), "2");
    assert.equal(url.searchParams.get("limit"), "20");
    assert.match(new Headers(init?.headers).get("user-agent") ?? "", /MotingReader/);
    return Response.json({ numFound: 45, docs: [
      { key: "/works/OL123W", title: "Original Title", author_name: ["作者甲", "作者乙"], first_publish_year: 2006, cover_i: 7, editions: { docs: [{ title: "中文版书名", cover_i: 8 }] } },
      { key: "OL124W", title: "No Cover" },
    ] });
  }));
  assert.equal(response.status, 200);
  const data = await response.json() as { books: Array<{ workId: string; title: string; author: string; year: number | null; coverUrl: string | null; sourceUrl: string }>; page: number; hasMore: boolean };
  assert.deepEqual(data, {
    books: [
      { workId: "OL123W", title: "中文版书名", author: "作者甲 · 作者乙", year: 2006, coverUrl: "https://covers.openlibrary.org/b/id/8-M.jpg", sourceUrl: "https://openlibrary.org/works/OL123W" },
      { workId: "OL124W", title: "No Cover", author: "", year: null, coverUrl: null, sourceUrl: "https://openlibrary.org/works/OL124W" },
    ], page: 2, hasMore: true,
  });
  assert.match(response.headers.get("cache-control") ?? "", /max-age=1800/);
});

test("free text and English filter stay on the fixed Open Library host", async () => {
  const response = await handleDiscovery(request(`/api/discovery/search?query=${encodeURIComponent("三体 & Foundation")}&language=en`), undefined, fetcher((url) => {
    assert.equal(url.origin, "https://openlibrary.org");
    assert.equal(url.searchParams.get("q"), "三体 & Foundation language:eng");
    assert.equal(url.searchParams.get("lang"), "en");
    return Response.json({ num_found: 0, docs: [] });
  }));
  assert.deepEqual(await response.json(), { books: [], page: 1, hasMore: false });
});

test("work details support string and object descriptions without inventing absent data", async () => {
  const first = await handleDiscovery(request("/api/discovery/work?id=OL123W"), undefined, fetcher((url) => {
    assert.equal(url.href, "https://openlibrary.org/works/OL123W.json");
    return Response.json({ key: "/works/OL123W", description: { type: "/type/text", value: "书籍简介" }, subjects: ["文学", "历史"] });
  }));
  assert.deepEqual(await first.json(), { description: "书籍简介", subjects: ["文学", "历史"] });
  const second = await handleDiscovery(request("/api/discovery/work?id=OL124W"), undefined, fetcher(() => Response.json({ key: "/works/OL124W" })));
  assert.deepEqual(await second.json(), { description: null, subjects: [] });
});

test("invalid inputs never reach upstream", async () => {
  for (const path of [
    "/api/discovery/search?topic=invalid",
    "/api/discovery/search?topic=fiction&query=test",
    "/api/discovery/search?topic=literature&page=0",
    "/api/discovery/search?query=x&language=jp",
    "/api/discovery/work?id=../../etc/passwd",
  ]) {
    const response = await handleDiscovery(request(path), undefined, unused);
    assert.equal(response.status, 400, path);
  }
  assert.equal((await handleDiscovery(request("/api/discovery/search?topic=literature", "POST"), undefined, unused)).status, 405);
});

test("rate limits, invalid JSON and changed schemas show errors", async () => {
  const path = "/api/discovery/search?topic=literature";
  const rateLimited = await handleDiscovery(request(path), undefined, fetcher(() => new Response("", { status: 429 })));
  assert.equal(rateLimited.status, 503);
  assert.match((await rateLimited.json() as { error: string }).error, /请求较多/);
  for (const upstream of [
    new Response("<html>Blocked</html>", { headers: { "content-type": "text/html" } }),
    Response.json({ unexpected: true }),
    Response.json({ docs: [{ title: "missing key" }] }),
    new Response("x".repeat(1024 * 1024 + 1), { headers: { "content-type": "application/json" } }),
  ]) {
    const response = await handleDiscovery(request(path), undefined, fetcher(() => upstream));
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});
