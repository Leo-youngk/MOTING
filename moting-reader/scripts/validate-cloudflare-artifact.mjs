import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";

const workerPath = new URL("../dist/server/index.js", import.meta.url);
const configPath = new URL("../dist/server/wrangler.json", import.meta.url);

const config = JSON.parse(await readFile(configPath, "utf8"));

assert.equal(config.name, "moting-reader");
assert.equal(config.main, "index.js");
assert.equal(config.no_bundle, true);
assert.equal(config.assets?.directory, "../client");
assert.ok(
  Array.isArray(config.compatibility_flags) &&
    config.compatibility_flags.includes("nodejs_compat"),
);

const workerUrl = new URL(workerPath);
workerUrl.searchParams.set("artifact-validation", `${process.pid}-${Date.now()}`);
const worker = await import(workerUrl.href);

assert.equal(typeof worker.default?.fetch, "function");

console.log(
  "Validated Cloudflare artifact: Worker entry, static assets, and compatibility settings are present.",
);

// 完整清单包含动态 import 分片；HTML 中的入口/preload 标签不能代表整个构建。
const assetsRoot = new URL("../dist/client/assets/", import.meta.url);
const files = await readdir(assetsRoot, { recursive: true, withFileTypes: true });
const { relative, join } = await import("node:path");
const { fileURLToPath } = await import("node:url");
const assets = files.filter((entry) => entry.isFile()).map((entry) =>
  "/assets/" + relative(fileURLToPath(assetsRoot), join(entry.parentPath, entry.name)).split("\\").join("/")
).sort();
assert.ok(assets.length > 0, "Build asset manifest must not be empty");
await writeFile(new URL("../dist/client/asset-manifest.json", import.meta.url), JSON.stringify({ assets }));
