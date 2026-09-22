import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanTitleText,
  decideAutoApply,
  formatAuthors,
  isPlaceholderAuthor,
  lookupQuery,
  needsMetadataLookup,
  normalizeTitleKey,
  titleLooksLikeFileName,
} from "../lib/book-metadata.ts";
import type { BookMetadataCandidate } from "../lib/book-metadata-types.ts";
import { handleBookMetadata } from "../worker/book-metadata.ts";
import type { Book } from "../lib/types.ts";

function book(overrides: Partial<Book> = {}): Book {
  return {
    id: "book_1",
    title: "三国演义",
    author: "罗贯中",
    format: "epub",
    fileName: "三国演义.epub",
    accent: "#8a6d3b",
    status: "ready",
    createdAt: 0,
    updatedAt: 0,
    lastOpenedAt: 0,
    chapters: [],
    sentenceCount: 0,
    characterCount: 0,
    ...overrides,
  };
}

function candidate(overrides: Partial<BookMetadataCandidate> = {}): BookMetadataCandidate {
  return {
    volumeId: "vol_1",
    title: "三国演义",
    authors: ["罗贯中"],
    publishedDate: "2019-01-01",
    description: null,
    categories: [],
    coverUrl: null,
    language: "zh-CN",
    infoLink: null,
    ...overrides,
  };
}

function request(path: string, method = "GET") {
  return new Request(`https://reader.example${path}`, { method });
}

function fetcher(fn: (url: URL, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return async (url, init) => fn(new URL(String(url)), init);
}

const unused = fetcher(() => {
  throw new Error("Unexpected upstream request");
});

const env = { GOOGLE_BOOKS_API_KEY: "test-key" };

test("书名指纹抹掉盗版噪声，但不会把不同的书抹成同一本", () => {
  assert.equal(normalizeTitleKey("三国演义(完整版)@某某书屋"), "三国演义");
  assert.equal(normalizeTitleKey("《三国演义》"), "三国演义");
  assert.equal(normalizeTitleKey("三国演义.epub"), "三国演义");
  assert.notEqual(normalizeTitleKey("三国演义"), normalizeTitleKey("水浒传"));
  assert.equal(cleanTitleText("活着【精校版】"), "活着");
});

test("占位作者与文件名书名能被认出来", () => {
  assert.equal(isPlaceholderAuthor("未知作者"), true);
  assert.equal(isPlaceholderAuthor("  "), true);
  assert.equal(isPlaceholderAuthor("余华"), false);
  assert.equal(
    titleLooksLikeFileName(book({ title: "活着 余华", fileName: "活着 余华.txt" })),
    true
  );
  assert.equal(
    titleLooksLikeFileName(book({ title: "活着", fileName: "yu-hua-to-live.epub" })),
    false
  );
});

test("上游脏作者字段被清理成一行可读的署名", () => {
  assert.equal(formatAuthors(["加西亚. 马克斯", "于娜 (翻译 )"]), "加西亚. 马克斯 · 于娜");
  assert.equal(formatAuthors(["刘慈欣", "刘慈欣"]), "刘慈欣");
  assert.equal(formatAuthors([]), "");
});

test("资料齐全的书不查询，缺封面或缺作者的才查", () => {
  assert.equal(
    needsMetadataLookup(book({ coverDataUrl: "data:image/webp;base64,x" })),
    false,
    "书名跟文件名一样是正常现象，不能因此就去查"
  );
  assert.equal(
    needsMetadataLookup(
      book({ title: "三国演义(完整版)", coverDataUrl: "data:image/webp;base64,x" })
    ),
    true,
    "书名带噪声才算脏"
  );
  assert.equal(needsMetadataLookup(book()), true, "没有封面就该查");
  assert.equal(
    needsMetadataLookup(book({ author: "未知作者", coverDataUrl: "data:image/webp;base64,x" })),
    true
  );
  assert.equal(needsMetadataLookup(book({ format: "demo" })), false);
  assert.equal(needsMetadataLookup(book({ status: "parsing" })), false);
});

test("书名指纹对不上就一个字段都不套用", () => {
  const dirty = book({ title: "水浒传", author: "未知作者" });
  assert.equal(decideAutoApply(dirty, [candidate()]), null);
});

test("只补脏字段：EPUB 里正确的书名作者封面一律不碰", () => {
  const clean = book({ coverDataUrl: "data:image/webp;base64,x" });
  assert.equal(
    decideAutoApply(clean, [candidate({ title: "三国演义", authors: ["罗贯中 校注版"] })]),
    null,
    "全都齐全时不该产生任何改动"
  );

  const dirty = book({
    title: "三国演义(完整版)@某某书屋",
    author: "未知作者",
    fileName: "三国演义(完整版)@某某书屋.txt",
  });
  const decision = decideAutoApply(dirty, [candidate({ coverUrl: "https://books.google.com/x" })]);
  assert.ok(decision);
  assert.equal(decision.title, "三国演义");
  assert.equal(decision.author, "罗贯中");
  assert.equal(decision.wantCover, true);
});

test("书名脏但作者本来就对时，只换书名不动作者", () => {
  const dirty = book({
    title: "三国演义(完整版)",
    author: "罗贯中",
    fileName: "三国演义(完整版).txt",
    coverDataUrl: "data:image/webp;base64,x",
  });
  const decision = decideAutoApply(dirty, [candidate({ authors: ["罗贯中 等"] })]);
  assert.ok(decision);
  assert.equal(decision.title, "三国演义");
  assert.equal(decision.author, undefined);
  assert.equal(decision.wantCover, false);
});

test("查询词去掉噪声，作者是占位值时不参与查询", () => {
  assert.deepEqual(
    lookupQuery(book({ title: "活着【精校版】", author: "未知作者" })),
    { title: "活着", author: "" }
  );
  assert.deepEqual(lookupQuery(book({ title: "活着", author: "余华" })), {
    title: "活着",
    author: "余华",
  });
});

test("查询必须走 intitle:/inauthor: 字段算子，并带上 country", async () => {
  const response = await handleBookMetadata(
    request("/api/metadata/lookup?title=%E6%B4%BB%E7%9D%80&author=%E4%BD%99%E5%8D%8E"),
    env,
    undefined,
    fetcher((url) => {
      assert.equal(url.origin, "https://www.googleapis.com");
      assert.equal(url.pathname, "/books/v1/volumes");
      assert.equal(url.searchParams.get("q"), 'intitle:"活着" inauthor:"余华"');
      assert.equal(url.searchParams.get("country"), "US");
      assert.equal(url.searchParams.get("key"), "test-key");
      return Response.json({
        items: [
          {
            id: "vol_a",
            volumeInfo: {
              title: "活着",
              subtitle: "余华作品",
              authors: ["余华"],
              publishedDate: "2012-08",
              description: "小说",
              categories: ["Fiction"],
              language: "zh-CN",
              imageLinks: {
                thumbnail: "http://books.google.com/books/content?id=a&edge=curl&zoom=1",
              },
            },
          },
          { id: "vol_b", volumeInfo: {} },
        ],
      });
    })
  );
  assert.equal(response.status, 200);
  const data = (await response.json()) as { candidates: BookMetadataCandidate[] };
  assert.equal(data.candidates.length, 1, "缺标题的条目要丢掉，不要凑数");
  assert.deepEqual(data.candidates[0], {
    volumeId: "vol_a",
    title: "活着：余华作品",
    authors: ["余华"],
    publishedDate: "2012-08",
    description: "小说",
    categories: ["Fiction"],
    coverUrl: "https://books.google.com/books/content?id=a&zoom=1",
    language: "zh-CN",
    infoLink: null,
  });
});

test("没有结果时返回空列表而不是报错", async () => {
  const response = await handleBookMetadata(
    request("/api/metadata/lookup?title=%E4%B8%8D%E5%AD%98%E5%9C%A8%E7%9A%84%E4%B9%A6"),
    env,
    undefined,
    fetcher(() => Response.json({ totalItems: 0 }))
  );
  assert.deepEqual(await response.json(), { candidates: [] });
});

test("没配密钥就说没配，不能返回空列表假装查不到", async () => {
  const response = await handleBookMetadata(
    request("/api/metadata/lookup?title=%E6%B4%BB%E7%9D%80"),
    {},
    undefined,
    unused
  );
  assert.equal(response.status, 503);
  assert.match((await response.json() as { error: string }).error, /未配置/);
});

test("无效输入不会打到上游", async () => {
  for (const path of [
    "/api/metadata/lookup",
    "/api/metadata/lookup?title=",
    `/api/metadata/lookup?title=${"x".repeat(201)}`,
    "/api/metadata/lookup?title=%E6%B4%BB%E7%9D%80&author=%00",
  ]) {
    const response = await handleBookMetadata(request(path), env, undefined, unused);
    assert.equal(response.status, 400, path);
  }
  const post = await handleBookMetadata(
    request("/api/metadata/lookup?title=%E6%B4%BB%E7%9D%80", "POST"),
    env,
    undefined,
    unused
  );
  assert.equal(post.status, 405);
});

test("封面转发只放行 Google 自己的图床", async () => {
  const blocked = await handleBookMetadata(
    request(`/api/metadata/cover?u=${encodeURIComponent("https://evil.example/x.png")}`),
    env,
    undefined,
    unused
  );
  assert.equal(blocked.status, 400);

  const insecure = await handleBookMetadata(
    request(`/api/metadata/cover?u=${encodeURIComponent("http://books.google.com/x.png")}`),
    env,
    undefined,
    unused
  );
  assert.equal(insecure.status, 400);

  const ok = await handleBookMetadata(
    request(`/api/metadata/cover?u=${encodeURIComponent("https://books.google.com/x.png")}`),
    env,
    undefined,
    fetcher(() => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } }))
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/jpeg");
});

test("上游返回网页而不是图片时不当封面用", async () => {
  const response = await handleBookMetadata(
    request(`/api/metadata/cover?u=${encodeURIComponent("https://books.google.com/x.png")}`),
    env,
    undefined,
    fetcher(() => new Response("<html></html>", { headers: { "content-type": "text/html" } }))
  );
  assert.equal(response.status, 502);
});
