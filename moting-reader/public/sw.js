// 页面本体（"/"）缓存优先：打开时直接用缓存里的那一份，同时在后台取新的，下次打开生效。
// 以前是先等网络——每次打开都要先等 Cloudflare 回一趟，网络差又没断的时候就一直白屏。
//
// 存新页面时，把它引用的 /assets/ 脚本和样式一起存齐了再替换页面本体：
// Workers 每次发版只留新版文件，缓存里的旧页面要是缺了自己那一版的脚本，就再也跑不起来。
//
// 图标、manifest 这些文件名不带内容哈希，改了它们要顺手把版本号加一，否则已装的 PWA 永远拿旧的。
const CACHE_NAME = "moting-shell-v14";
const SHELL_FILES = [
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
  "/bear-mark.png",
];
/** 记着缓存里那份页面用到了哪些 /assets/ 文件，用来提示当前页面有可用更新。 */
const ASSET_LIST_KEY = "/__shell-assets.json";

/** 缓存里那份页面用到的 /assets/ 文件。页面拿它跟自己开机时加载的比，多出来的就说明有新版。 */
async function cachedAssets() {
  const cache = await caches.open(CACHE_NAME);
  const stored = await cache.match(ASSET_LIST_KEY);
  return stored ? stored.json().catch(() => []) : [];
}

/** 把缓存里那一版的文件清单告诉页面（不指定就是所有打开着的页面）。 */
async function announceShell(target, offline = false) {
  const message = { type: "shell", assets: await cachedAssets(), offline };
  const clients = target ? [target] : await self.clients.matchAll({ type: "window" });
  clients.forEach((client) => client.postMessage(message));
}

async function refreshShell() {
  const response = await fetch("/", { cache: "no-store" });
  const type = response.headers.get("content-type") || "";
  if (!response.ok || !type.includes("text/html")) throw new Error(`shell ${response.status}`);
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

  // 保存新清单但保留旧哈希资源。仍打开的旧页面可能稍后才触发动态 import，
  // 此时删掉旧分片会把阅读器留在半失效状态。
  const previous = await cache.match(ASSET_LIST_KEY);
  const before = previous ? await previous.json().catch(() => []) : [];
  const changed = before.length !== assets.length || before.some((path) => !assets.includes(path));
  if (changed) {
    await cache.put(
      ASSET_LIST_KEY,
      new Response(JSON.stringify(assets), { headers: { "content-type": "application/json" } })
    );
    // Keep one previous asset generation for open tabs, then drop older hashed bundles
    // so repeated deployments cannot grow this cache without a bound.
    const keep = new Set([...before, ...assets]);
    const keys = await cache.keys();
    await Promise.all(
      keys
        .map((request) => new URL(request.url).pathname)
        .filter((path) => path.startsWith("/assets/") && !keep.has(path))
        .map((path) => cache.delete(path))
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
      .then((keys) => {
        const oldShells = keys
          .filter((key) => key.startsWith("moting-shell-") && key !== CACHE_NAME)
          .sort((left, right) => {
            const version = (key) => Number(/-v(\d+)$/.exec(key)?.[1] ?? 0);
            return version(right) - version(left);
          });
        const keep = new Set([CACHE_NAME, ...oldShells.slice(0, 1)]);
        return Promise.all(keys.filter((key) => !keep.has(key)).map((key) => caches.delete(key)));
      })
      .then(() => self.clients.claim())
  );
});

// 页面开机、从后台切回来、在设置里点「检查更新」时发 check-update：去取一次最新页面，
// 取不到（离线）就照旧回报缓存里的那一版，页面据此显示「已是最新」或「有新版本」。
self.addEventListener("message", (event) => {
  if (event.data?.type !== "check-update") return;
  event.waitUntil(
    refreshShell()
      .then(() => announceShell(event.source))
      .catch(() => announceShell(event.source, true))
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
    // 取完告诉页面：新版已经存好了，页面上会出「更新」，点一下重新载入就是新版。
    event.waitUntil(refreshShell().catch(() => undefined).then(() => announceShell()));
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
    caches
      .open(CACHE_NAME)
      .then((currentCache) => currentCache.match(request))
      .then(async (currentCached) => {
        const cached = currentCached || (await caches.match(request));
        if (cached) return cached;
        const response = await fetch(request);
        if (response.status === 404 && url.pathname.startsWith("/assets/")) {
          const client = event.clientId ? await self.clients.get(event.clientId) : null;
          client?.postMessage({ type: "shell-expired" });
        }
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
  );
});
