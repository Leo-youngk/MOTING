import assert from "node:assert/strict";
import test from "node:test";
import { handleZlibrary } from "../worker/zlibrary.ts";
import { ONLINE_BOOK_MAX_BYTES, ZLIBRARY_ORIGIN } from "../lib/zlibrary-types.ts";

// 全部为协议测试夹具，不接入生产数据，不消耗真实账号下载次数。
const cookie = "moting_zlib_id=123; moting_zlib_key=test_session_key_123";
function request(action: string, body: object = {}, headers: Record<string, string> = {}) {
  return new Request(`https://reader.example/api/zlibrary/${action}`, { method: "POST", headers: { "content-type": "application/json", origin: "https://reader.example", ...headers }, body: JSON.stringify(body) });
}
function reply(data: unknown) { return Response.json(data); }
async function responseJson<T>(response: Response): Promise<T> { return (await response.json()) as T; }
function fetcher(fn: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return async (url, init) => fn(String(url), init);
}
const unused = fetcher(() => { throw new Error("Unexpected network request"); });
const sample = { id: 17, hash: "aabbcc", title: "测试书", author: "测试作者", extension: "epub", language: "中文", filesize: 2048 };

test("login uses current website protocol and returns only HttpOnly session cookies", async () => {
  const response = await handleZlibrary(request("login", { email: "reader@example.org", password: "test-password" }), fetcher((url, init) => {
    assert.equal(url, `${ZLIBRARY_ORIGIN}/rpc.php`);
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get("action"), "login");
    assert.equal(form.get("site_mode"), "books");
    assert.equal(form.get("password"), "test-password");
    assert.equal(init?.redirect, "manual");
    return reply({ errors: [], response: { user_id: 123, user_key: "test_session_key_123" } });
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { connected: true });
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  cookies.forEach((value) => { assert.match(value, /HttpOnly; SameSite=Strict/); assert.match(value, /; Secure/); });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("incorrect login is surfaced instead of accepting a validation response", async () => {
  const response = await handleZlibrary(request("login", { email: "reader@example.org", password: "wrong" }), fetcher(() => reply({ errors: [], response: { validationError: true, message: "Incorrect email or password" } })));
  assert.equal(response.status, 401);
  const data = await responseJson<{ error: string }>(response);
  assert.match(data.error, /邮箱或密码/);
  assert.equal(response.headers.getSetCookie().length, 0);
});

test("session and logout do not expose credentials or make upstream requests", async () => {
  const connected = await handleZlibrary(request("session", {}, { cookie }), unused);
  assert.deepEqual(await connected.json(), { connected: true });
  const guest = await handleZlibrary(request("session"), unused);
  assert.deepEqual(await guest.json(), { connected: false });
  const logout = await handleZlibrary(request("logout", {}, { cookie }), unused);
  logout.headers.getSetCookie().forEach((value) => assert.match(value, /Max-Age=0/));
});

test("search encodes Chinese query, forwards only its account, normalizes results and pagination", async () => {
  const response = await handleZlibrary(request("search", { query: "书名 & 作者", page: 2 }, { cookie: `${cookie}; unrelated=secret` }), fetcher((url, init) => {
    assert.equal(url, `${ZLIBRARY_ORIGIN}/eapi/book/search`);
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get("message"), "书名 & 作者");
    assert.equal(form.get("page"), "2");
    assert.equal(form.get("extensions[0]"), "epub");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("cookie"), "siteLanguageV2=zh; remix_userid=123; remix_userkey=test_session_key_123");
    assert.equal(headers.get("remix-userid"), "123");
    assert.equal(headers.get("remix-userkey"), "test_session_key_123");
    assert.equal(headers.get("x-requested-with"), "XMLHttpRequest");
    return reply({ success: 1, books: [{ ...sample, id: 18, extension: "pdf" }, sample], pagination: { total_items: 43 } });
  }));
  const data = await responseJson<{ books: Array<{ extension: string; bytes: number }>; page: number; hasMore: boolean }>(response);
  assert.equal(data.books[0].extension, "epub");
  assert.equal(data.books[0].bytes, 2048);
  assert.equal(data.page, 2);
  assert.equal(data.hasMore, true);
});

test("search retries one transient upstream stall and reuses the form body", async () => {
  let calls = 0;
  const response = await handleZlibrary(request("search", { query: "重试测试" }), fetcher((_url, init) => {
    calls += 1;
    assert.equal(String(init?.body), "message=%E9%87%8D%E8%AF%95%E6%B5%8B%E8%AF%95&page=1&limit=20&extensions%5B0%5D=epub&extensions%5B1%5D=pdf&extensions%5B2%5D=txt&extensions%5B3%5D=md");
    if (calls === 1) throw new Error("upstream timeout");
    return reply({ success: 1, books: [{ ...sample, id: 19 }] });
  }));
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.equal((await responseJson<{ books: unknown[] }>(response)).books.length, 1);
});

test("guest search and exact match response are supported", async () => {
  const response = await handleZlibrary(request("search", { query: "测试" }), fetcher((_url, init) => {
    const form = new URLSearchParams(String(init?.body));
    assert.deepEqual(["epub", "pdf", "txt", "md"].map((_, index) => form.get(`extensions[${index}]`)), ["epub", "pdf", "txt", "md"]);
    return reply({ success: 1, exactMatch: { books: [{ ...sample, extension: "pdf" }] } });
  }));
  assert.equal((await responseJson<{ books: unknown[] }>(response)).books.length, 1);
});

test("malformed upstream JSON and changed schemas do not masquerade as empty searches", async () => {
  for (const make of [() => new Response("<html>Verify</html>"), () => reply({ success: 1 }), () => reply({ books: [{ title: "missing identity" }] })]) {
    const response = await handleZlibrary(request("search", { query: "测试" }), fetcher(make));
    assert.equal(response.status, 502);
    assert.ok((await responseJson<{ error?: unknown }>(response)).error);
  }
  const empty = await handleZlibrary(request("search", { query: "测试" }), fetcher(() => reply({ books: [] })));
  assert.deepEqual((await responseJson<{ books: unknown[] }>(empty)).books, []);
});

test("auth rejection clears an expired session and opens a re-login path", async () => {
  const response = await handleZlibrary(request("search", { query: "测试" }, { cookie }), fetcher(() => reply({ success: 0, error: { message: "Please login" } })));
  assert.equal(response.status, 401);
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.match(response.headers.getSetCookie()[0], /Max-Age=0/);
});

test("cross-site requests, invalid methods and identifiers never reach upstream", async () => {
  const cases: [Request, number][] = [
    [request("login", {}, { origin: "https://attacker.example" }), 403],
    [request("search", {}, { "sec-fetch-site": "cross-site" }), 403],
    [request("search", { query: "x", page: -1 }), 400],
    [request("search", { query: "x", page: 1.5 }), 400],
    [request("search", { query: "x".repeat(201) }), 400],
    [request("download", { id: "../../secret", hash: "aa" }), 400],
    [new Request("https://reader.example/api/zlibrary/session"), 405],
    [request("session", {}, { "content-type": "text/plain" }), 415],
    [request("session", { huge: "x".repeat(9000) }), 400],
  ];
  for (const [input, status] of cases) assert.equal((await handleZlibrary(input, unused)).status, status);
});

test("upstream denial, redirection and connection failure produce actionable errors", async () => {
  for (const [status, expected] of [[403, 502], [429, 429], [503, 502], [302, 502]]) {
    const response = await handleZlibrary(request("search", { query: "测试" }), fetcher(() => new Response("", { status })));
    assert.equal(response.status, expected);
  }
  const offline = await handleZlibrary(request("search", { query: "测试" }), fetcher(() => { throw new Error("network"); }));
  assert.equal(offline.status, 503);
});

function fileFetcher(file: Record<string, unknown>, downloadResponse: () => Response = () => new Response("测试正文")): typeof fetch {
  return fetcher((url, init) => {
    if (url.startsWith(ZLIBRARY_ORIGIN)) return reply({ success: 1, file: { description: "测试书", extension: "txt", downloadLink: "https://files.example/book", ...file } });
    assert.equal(new Headers(init?.headers).has("cookie"), false);
    return downloadResponse();
  });
}

test("download resolves file via book identity and streams it without leaking auth to CDN", async () => {
  const response = await handleZlibrary(request("download", { id: 17, hash: "aabbcc", url: "https://attacker.example" }, { cookie }), fileFetcher({}));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "测试正文");
  assert.equal(decodeURIComponent(response.headers.get("x-book-filename") || ""), "测试书.txt");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("quota errors, unsupported formats, HTML downloads and oversized books are rejected", async () => {
  const cases: [typeof fetch, number][] = [
    [fileFetcher({ downloadLink: "", allowDownload: false }), 429],
    [fileFetcher({ extension: "mobi" }), 422],
    [fileFetcher({}, () => new Response("html", { headers: { "content-type": "text/html" } })), 422],
    [fileFetcher({}, () => new Response("", { headers: { "content-length": String(ONLINE_BOOK_MAX_BYTES + 1) } })), 422],
  ];
  for (const [fetch, status] of cases) assert.equal((await handleZlibrary(request("download", { id: 17, hash: "aabbcc" }), fetch)).status, status);
});

test("unsafe file URLs and redirected private IPs are never fetched", async () => {
  for (const url of ["http://files.example/book", "https://127.0.0.1/x", "https://10.1.2.3/x", "https://[::1]/x", "https://localhost/x", "https://test.internal/x", "https://a:b@files.example/x"]) {
    const response = await handleZlibrary(request("download", { id: 17, hash: "aa" }), fileFetcher({ downloadLink: url }));
    assert.equal(response.status, 502, url);
  }
  const response = await handleZlibrary(request("download", { id: 17, hash: "aa" }), fileFetcher({}, () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/secret" } })));
  assert.equal(response.status, 502);
});

test("truncated stream is an error rather than a successful partial book", async () => {
  const response = await handleZlibrary(request("download", { id: 17, hash: "aa" }), fileFetcher({}, () => new Response("short", { headers: { "content-length": "100" } })));
  await assert.rejects(response.text(), /Incomplete book download/);
});
