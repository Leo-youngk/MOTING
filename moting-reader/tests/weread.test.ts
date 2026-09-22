import assert from "node:assert/strict";
import test from "node:test";
import { handleWeread } from "../worker/weread.ts";
import { wereadCoverUrl } from "../lib/weread.ts";
import {
  formatRatingCount,
  formatReadingCount,
  ratingPercent,
  type WereadBook,
} from "../lib/weread-types.ts";

const env = { WEREAD_API_KEY: "wrk-test" };

function request(path: string, method = "GET") {
  return new Request(`https://reader.example${path}`, { method });
}

function gateway(
  handler: (body: Record<string, unknown>) => unknown
): typeof fetch {
  return async (url, init) => {
    const target = String(url);
    if (target.startsWith("https://i.weread.qq.com")) {
      assert.equal(init?.method, "POST");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer wrk-test");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      // 网关强制要求上报版本，漏了会被当成过期客户端。
      assert.ok(body.skill_version, "每个请求都必须带 skill_version");
      return Response.json(handler(body));
    }
    // 封面直链
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/jpeg" },
    });
  };
}

const unused = (() => {
  throw new Error("Unexpected upstream request");
}) as unknown as typeof fetch;

test("推荐值是千分制，930 要显示成 93.0%", () => {
  assert.equal(ratingPercent(930), "93.0%");
  assert.equal(ratingPercent(854), "85.4%");
  assert.equal(ratingPercent(null), null, "没有评分就是没有，不能顶成 0%");
});

test("人数按万折算，0 和 null 都不显示", () => {
  assert.equal(formatRatingCount(213269), "21.3 万人");
  assert.equal(formatRatingCount(842), "842 人");
  assert.equal(formatRatingCount(0), null);
  assert.equal(formatReadingCount(10976), "1.1 万人在读");
  assert.equal(formatReadingCount(null), null);
});

test("搜索走 scope=10 电子书，并把评分从外层收进书里", async () => {
  const response = await handleWeread(
    request("/api/weread/search?keyword=%E6%B4%BB%E7%9D%80&count=5"),
    env,
    undefined,
    gateway((body) => {
      assert.equal(body.api_name, "/store/search");
      assert.equal(body.keyword, "活着");
      assert.equal(body.scope, 10, "书城只搜电子书");
      return {
        results: [
          {
            scopeCount: 42,
            books: [
              {
                // 搜索结果的评分挂在 bookInfo 外面那层，不是里面。
                readingCount: 3396,
                bookInfo: {
                  bookId: "834464",
                  title: "活着",
                  author: "余华",
                  cover: "http://cdn.weread.qq.com/a.jpg",
                  newRating: 920,
                  newRatingCount: 213269,
                  newRatingDetail: { title: "神作" },
                },
              },
              { bookInfo: { title: "缺 bookId 的脏数据" } },
            ],
          },
        ],
      };
    })
  );
  assert.equal(response.status, 200);
  const data = (await response.json()) as { books: WereadBook[] };
  assert.equal(data.books.length, 1, "缺 bookId 的条目要丢掉");
  assert.deepEqual(data.books[0], {
    bookId: "834464",
    title: "活着",
    author: "余华",
    translator: null,
    coverUrl: "https://cdn.weread.qq.com/a.jpg",
    intro: null,
    category: null,
    rating: 920,
    ratingCount: 213269,
    ratingLabel: "神作",
    readingCount: 3396,
  });
});

test("相似推荐必须同时带 maxIdx 和 sessionId，否则网关回参数格式错误", async () => {
  const seen: Record<string, unknown> = {};
  const response = await handleWeread(
    request("/api/weread/similar?bookId=834464"),
    env,
    undefined,
    gateway((body) => {
      if (body.api_name === "/book/similar") {
        Object.assign(seen, body);
        return {
          booksimilar: {
            sessionId: "session_x",
            books: [
              { book: { bookInfo: { bookId: "24965201", title: "平凡的世界（全三册）", author: "路遥" } } },
            ],
          },
        };
      }
      // 补查评分
      return { bookId: "24965201", title: "平凡的世界（全三册）", newRating: 940, newRatingCount: 88000, newRatingDetail: { title: "神作" } };
    })
  );
  assert.equal(seen.api_name, "/book/similar");
  assert.equal(seen.maxIdx, 0);
  assert.equal(seen.sessionId, "");
  const data = (await response.json()) as { books: WereadBook[]; sessionId: string };
  assert.equal(data.sessionId, "session_x");
  assert.equal(data.books[0].title, "平凡的世界（全三册）");
  assert.equal(data.books[0].rating, 940, "相似推荐不带评分，要按本补查回来");
});

test("推荐流补不到评分时留 null，不编一个数字", async () => {
  const response = await handleWeread(
    request("/api/weread/recommend?count=2"),
    env,
    undefined,
    gateway((body) => {
      if (body.api_name === "/book/recommend") {
        return { books: [{ bookId: "a", title: "甲", author: "A" }] };
      }
      return { errcode: -2003, errmsg: "参数格式错误" };
    })
  );
  const data = (await response.json()) as { books: WereadBook[] };
  assert.equal(data.books[0].rating, null);
  assert.equal(data.books[0].ratingLabel, null);
});

test("上游 errcode 非 0 时把原因带出来", async () => {
  const response = await handleWeread(
    request("/api/weread/book?bookId=834464"),
    env,
    undefined,
    gateway(() => ({ errcode: -2003, errmsg: "参数格式错误" }))
  );
  assert.equal(response.status, 502);
  assert.match((await response.json() as { error: string }).error, /参数格式错误/);
});

test("没配密钥就说没配，不能返回空列表假装书城是空的", async () => {
  const response = await handleWeread(request("/api/weread/recommend"), {}, undefined, unused);
  assert.equal(response.status, 503);
  assert.match((await response.json() as { error: string }).error, /未配置/);
});

test("无效输入不会打到上游", async () => {
  for (const path of [
    "/api/weread/search",
    "/api/weread/search?keyword=",
    "/api/weread/book?bookId=../etc",
    "/api/weread/similar?bookId=%00",
  ]) {
    const response = await handleWeread(request(path), env, undefined, unused);
    assert.equal(response.status, 400, path);
  }
  assert.equal((await handleWeread(request("/api/weread/nope"), env, undefined, unused)).status, 404);
  assert.equal(
    (await handleWeread(request("/api/weread/search?keyword=a", "POST"), env, undefined, unused)).status,
    405
  );
});

test("封面转发只放行微信读书自己的图床", async () => {
  const blocked = await handleWeread(
    request(`/api/weread/cover?u=${encodeURIComponent("https://evil.example/x.jpg")}`),
    env,
    undefined,
    unused
  );
  assert.equal(blocked.status, 400);

  for (const allowed of [
    "https://cdn.weread.qq.com/weread/cover/80/x/s_x.jpg",
    "https://wfqqreader-1252317822.image.myqcloud.com/cover/457/22946457/s_22946457.jpg",
  ]) {
    const ok = await handleWeread(
      request(`/api/weread/cover?u=${encodeURIComponent(allowed)}`),
      env,
      undefined,
      gateway(() => ({}))
    );
    assert.equal(ok.status, 200, allowed);
    assert.equal(ok.headers.get("content-type"), "image/jpeg");
  }
});

test("封面按渲染尺寸选档：行 t4_、卡片 t7_、详情 t9_", () => {
  const large = "https://cdn.weread.qq.com/weread/cover/13/cpplatform_x/t6_cpplatform_x1784541125.jpg";
  assert.match(wereadCoverUrl(large, "card"), /%2Ft7_cpplatform_x1784541125\.jpg/);
  assert.match(wereadCoverUrl(large), /%2Ft9_cpplatform_x1784541125\.jpg/);
  // 本来就是缩略图的地址原样放过，不要造一个不存在的变体出来。
  const small = "https://wfqqreader-1252317822.image.myqcloud.com/cover/457/22946457/s_22946457.jpg";
  // s_ 那档太小（70×101），卡片上糊；任意档位都要能互转。
  assert.match(wereadCoverUrl(small, "card"), /%2Ft7_22946457\.jpg/);
  assert.match(wereadCoverUrl(small, "row"), /%2Ft4_22946457\.jpg/);
});

test("搜索要把所有分组摊平——scope=10 是一本书一个分组", async () => {
  const response = await handleWeread(
    request("/api/weread/search?keyword=%E7%A7%91%E5%B9%BB&count=20"),
    env,
    undefined,
    gateway(() => ({
      hasMore: 1,
      // 真实回包长这样：20 个分组，每组 scopeCount=1、books 里就一本。
      results: Array.from({ length: 3 }, (_, i) => ({
        title: "电子书",
        scopeCount: 1,
        books: [{ bookInfo: { bookId: `b${i}`, title: `书${i}`, author: "作者" } }],
      })),
    }))
  );
  const data = (await response.json()) as { books: WereadBook[]; hasMore: boolean };
  assert.equal(data.books.length, 3, "只读 results[0] 会永远只拿到一本书");
  assert.equal(data.hasMore, true);
});

test("榜单按推荐值排序，并卡掉评分人数不足的", async () => {
  let pagesAsked = 0;
  const response = await handleWeread(
    request("/api/weread/rank?category=%E7%A7%91%E5%B9%BB"),
    env,
    undefined,
    gateway((body) => {
      assert.equal(body.keyword, "科幻");
      pagesAsked += 1;
      const idx = Number(body.maxIdx);
      return {
        hasMore: 1,
        results: [
          {
            books: [
              {
                bookInfo: {
                  bookId: `hot${idx}`,
                  title: `热门${idx}`,
                  author: "A",
                  newRating: 900 + idx,
                  newRatingCount: 9000,
                },
              },
              {
                bookInfo: {
                  bookId: `thin${idx}`,
                  title: `冷门${idx}`,
                  author: "B",
                  newRating: 990,
                  newRatingCount: 12,
                },
              },
            ],
          },
        ],
      };
    })
  );
  assert.equal(pagesAsked, 3, "攒池要翻够页数");
  const data = (await response.json()) as {
    category: string;
    books: WereadBook[];
    poolSize: number;
  };
  assert.equal(data.category, "科幻");
  assert.equal(data.poolSize, 6);
  assert.deepEqual(
    data.books.map((b) => b.bookId),
    ["hot40", "hot20", "hot0"],
    "只有 12 个人打分的 99% 不能上榜"
  );
});
