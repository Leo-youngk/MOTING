import assert from "node:assert/strict";
import test from "node:test";

test("服务端入口输出可安装 PWA 的正式元数据", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  const html = await response.text();
  assert.match(html, /<html[^>]*\blang=["']zh-CN["']/i);
  assert.match(html, /<title>墨听阅读器<\/title>/i);
  assert.match(
    html,
    /<link(?=[^>]*\brel=["']manifest["'])(?=[^>]*\bhref=["']\/manifest\.webmanifest["'])[^>]*>/i,
  );

  // 线上曾经同时存在两条 viewport：平台按 metadata 默认发的那条只有 width/initial-scale，
  // 没有 viewport-fit=cover。多条 viewport 时按哪条算取决于浏览器和顺序，只要错拿到前一条，
  // env(safe-area-inset-*) 就全归零——刘海和 Home 条那块又没人管。这里锁住三件事：
  // 有一条带 viewport-fit=cover、每条都禁掉缩放、开机脚本会把所有 viewport 改成同一条。
  const viewports = [...html.matchAll(/<meta[^>]+name=["']viewport["'][^>]*>/gi)].map((match) => match[0]);
  assert.ok(viewports.length >= 1);
  assert.ok(viewports.some((meta) => /viewport-fit=cover/i.test(meta)));
  assert.ok(viewports.every((meta) => /maximum-scale=1/i.test(meta)));
  assert.ok(
    html.includes(`querySelectorAll('meta[name="viewport"]')`),
    "开机脚本要把每条 viewport 改成同一条，不能赌浏览器取哪一条",
  );

  // 宋体子集（62KB gz）不进首屏样式：外壳一律黑体，正文用到时才由开机脚本补上。
  assert.ok(html.includes(`fl.href="/fonts.css"`), "开机脚本要注入宋体样式表");
  assert.match(
    html,
    /<noscript><link[^>]*href=["']\/fonts\.css["'][^>]*>/i,
  );
});
