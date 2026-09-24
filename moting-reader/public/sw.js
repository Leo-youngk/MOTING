// 页面本体（"/"）缓存优先：打开时直接用缓存里的那一份，同时在后台取新的，下次打开生效。
// 以前是先等网络——每次打开都要先等 Cloudflare 回一趟，网络差又没断的时候就一直白屏。
//
// 存新页面时，把它引用的 /assets/ 脚本和样式一起存齐了再替换页面本体：
// Workers 每次发版只留新版文件，缓存里的旧页面要是缺了自己那一版的脚本，就再也跑不起来。
//
// 图标、manifest 这些文件名不带内容哈希，改了它们要顺手把版本号加一，否则已装的 PWA 永远拿旧的。
const CACHE_NAME = "moting-shell-v12";
const SHELL_FILES = [
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
  "/bear-mark.png",
];
/** 记着缓存里那份页面用到了哪些 /assets/ 文件，换版时据此清掉上一版的。 */
const ASSET_LIST_KEY = "/__shell-assets.json";

async function refreshShell() {
  const response = await fetch("/", { cache: "no-store" });
  const type = response.headers.get("content-type") || "";
  if (!response.ok || !type.includes("text/html")) return;
  const html = await response.clone().text();
  const assets = [...new Set(html.match(/\/assets\/[^"'\s)<>]+\.(?:js|mjs|css)/g) || [])];
  const cache = await caches.open(CACHE_NAME);

  // 这一版要用的文件先存齐。任何一个取不到就整次作罢，缓存里还是完整的上一版。
  await Promise.all(
    assets.map(async (path) => {
      if (await cache.match(path)) return;
      const asset = await fetch(path);
      if (!asset.ok) throw new Error(`${path} ${asset.status}`);
      await cache.put(path, asset);
    })
  );
  await cache.put("/", response);

  // 换了版才清：上一版的脚本（包括按需加载的分片）都不再需要。
  // 这一刻还开着的旧页面，按需分片开机时已经预取进内存；真漏了，页面会自己刷新到新版。
  const previous = await cache.match(ASSET_LIST_KEY);
  const before = previous ? await previous.json().catch(() => []) : [];
  const changed = before.length !== assets.length || before.some((path) => !assets.includes(path));
  if (changed) {
    const keep = new Set(assets);
    const keys = await cache.keys();
    await Promise.all(
      keys
        .map((request) => new URL(request.url).pathname)
        .filter((path) => path.startsWith("/assets/") && !keep.has(path))
        .map((path) => cache.delete(path))
    );
    await cache.put(
      ASSET_LIST_KEY,
      new Response(JSON.stringify(assets), { headers: { "content-type": "application/json" } })
    );
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => refreshShell().catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    // 后台取新版，打开这一下先用缓存里的；没有缓存（第一次打开）才等网络。
    event.waitUntil(refreshShell().catch(() => undefined));
    event.respondWith(
      caches
        .open(CACHE_NAME)
        .then((cache) => cache.match("/"))
        .then((cached) => cached || fetch(request).catch(() => caches.match("/")))
    );
    return;
  }

  // 分类书目是会重抓更新的静态数据，不能跟图标一样 cache-first 钉死，
  // 否则重抓之后已装的 PWA 永远读旧的那份。
  // stale-while-revalidate：有缓存先给缓存（进书城不再每次等一个来回），
  // 同时在后台取新的存起来，重新部署过的书目下次打开就是新的；离线时照样有得看。
  if (url.pathname.startsWith("/catalog/")) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        const refresh = fetch(request).then((response) => {
          if (!response.ok) return response;
          return cache.put(request, response.clone()).then(() => response);
        });
        if (cached) {
          event.waitUntil(refresh.catch(() => undefined));
          return cached;
        }
        return refresh;
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(
              caches.open(CACHE_NAME)
                .then((cache) => cache.put(request, copy))
                .catch(() => undefined)
            );
          }
          return response;
        })
    )
  );
});
