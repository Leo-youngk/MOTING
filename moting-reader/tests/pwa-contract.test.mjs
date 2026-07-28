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

test("离线外壳、系统语音和本地存储入口存在", async () => {
  const [serviceWorker, speech, storage, app] = await Promise.all([
    readFile(new URL("public/sw.js", root), "utf8"),
    readFile(new URL("hooks/use-speech-player.ts", root), "utf8"),
    readFile(new URL("lib/storage.ts", root), "utf8"),
    readFile(new URL("components/moting-app.tsx", root), "utf8"),
  ]);

  assert.match(serviceWorker, /caches\.open/);
  assert.match(serviceWorker, /request\.mode === "navigate"/);
  assert.match(speech, /SpeechSynthesisUtterance/);
  assert.match(speech, /sleepModeRef/);
  assert.match(storage, /indexedDB\.open/);
  assert.match(app, /name: "listen"/);
  assert.match(app, /\.epub,.pdf,.txt,.md,.markdown/);
});
