import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("PWA manifest 包含独立模式和完整图标", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("public/manifest.webmanifest", root), "utf8")
  );

  assert.equal(manifest.name, "墨听阅读器");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192"));
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512"));
  assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"));
});

test("离线外壳、云端语音和本地存储入口存在", async () => {
  const [serviceWorker, updateHook, speech, storage, app] = await Promise.all([
    readFile(new URL("public/sw.js", root), "utf8"),
    readFile(new URL("hooks/use-app-update.ts", root), "utf8"),
    readFile(new URL("hooks/use-speech-player.ts", root), "utf8"),
    readFile(new URL("lib/storage.ts", root), "utf8"),
    readFile(new URL("components/moting-app.tsx", root), "utf8"),
  ]);

  assert.match(serviceWorker, /caches\.open/);
  assert.match(serviceWorker, /request\.mode === "navigate"/);
  assert.match(serviceWorker, /保留旧哈希资源/);
  assert.match(serviceWorker, /type: "shell-expired"/);
  assert.match(updateHook, /data\?\.type === "shell-expired"/);
  assert.doesNotMatch(speech, /speechSynthesis|SpeechSynthesisUtterance/);
  assert.match(speech, /sleepModeRef/);
  assert.match(storage, /indexedDB\.open/);
  assert.match(app, /name: "listen"/);
  assert.match(app, /\.epub,.pdf,.txt,.md,.markdown/);
});

test("production manifest includes every hashed asset, including lazy chunks", async () => {
  const { readdir } = await import("node:fs/promises");
  const { relative, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const assetsRoot = new URL("dist/client/assets/", root);
  const files = await readdir(assetsRoot, { recursive: true, withFileTypes: true });
  const expected = files.filter(entry => entry.isFile()).map(entry =>
    "/assets/" + relative(fileURLToPath(assetsRoot), join(entry.parentPath, entry.name)).split("\\").join("/")
  ).sort();
  const manifest = JSON.parse(await readFile(new URL("dist/client/asset-manifest.json", root), "utf8"));
  assert.ok(expected.length > 0);
  assert.deepEqual(manifest.assets, expected);
});

// 宋体子集（/fonts.css，200 条 @font-face）曾经被 globals.css 直接 @import 进首屏样式，
// 每次冷启动都要背着 62KB gz 的字体声明——而外壳界面一律黑体，根本用不到。
// 拆出去之后没人注意就可能被重新 @import 回去，这里把它钉住。
test("首屏样式里没有宋体 @font-face，它们只在 /fonts.css 里", async () => {
  const { readdir } = await import("node:fs/promises");
  const assetsRoot = new URL("dist/client/assets/", root);
  const files = (await readdir(assetsRoot)).filter((name) => name.endsWith(".css"));
  assert.ok(files.length > 0);
  for (const name of files) {
    const css = await readFile(new URL(name, assetsRoot), "utf8");
    // 只数 @font-face：字体名还会出现在 --font-serif 的 fallback 链里，那不算。
    assert.equal((css.match(/@font-face/g) || []).length, 0, `${name} 不该带 @font-face`);
  }
  const fonts = await readFile(new URL("dist/client/fonts.css", root), "utf8");
  assert.match(fonts, /Noto Serif SC/);
  assert.match(fonts, /font-display: swap/);
});

// use-app-navigation 换掉 window.__VINEXT_RSC_NAVIGATE__，让应用自己的后退不去服务器取 RSC
// （取不到就整页重载，读完书返回书库会白屏重开）。前提是 vinext 在 popstate 发生时才读这个入口；
// 升级 vinext 后这里不过，说明那一招失效了，返回书库又会去拉 RSC。
test("后退时 vinext 从 window 上现取 RSC 导航入口，应用能拦下自己的后退", async () => {
  const { readdir } = await import("node:fs/promises");
  const assetsRoot = new URL("dist/client/assets/", root);
  const scripts = (await readdir(assetsRoot)).filter((name) => name.endsWith(".js"));
  const bundles = await Promise.all(scripts.map((name) => readFile(new URL(name, assetsRoot), "utf8")));
  const q = "[`\"']";
  const popstateReadsGlobal = new RegExp(
    `addEventListener\\(${q}popstate${q},[\\s\\S]{0,200}?window\\.__VINEXT_RSC_NAVIGATE__\\?\\.\\([^)]*${q}traverse${q}\\)`
  );
  assert.ok(bundles.some((code) => popstateReadsGlobal.test(code)));

  const navigation = await readFile(new URL("hooks/use-app-navigation.ts", root), "utf8");
  assert.match(navigation, /host\.__VINEXT_RSC_NAVIGATE__ = navigateRsc/);
});
