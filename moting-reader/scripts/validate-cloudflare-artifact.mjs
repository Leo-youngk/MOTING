import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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
