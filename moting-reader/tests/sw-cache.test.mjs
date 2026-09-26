import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const ROOT = new URL("../", import.meta.url);
const ORIGIN = "https://reader.example";

class MemoryCache {
  entries = new Map();

  key(input) {
    return new URL(typeof input === "string" ? input : input.url, ORIGIN).pathname;
  }

  async match(input) {
    return this.entries.get(this.key(input))?.clone();
  }

  async put(input, response) {
    this.entries.set(this.key(input), response.clone());
  }

  async delete(input) {
    return this.entries.delete(this.key(input));
  }

  async keys() {
    return [...this.entries.keys()].map((path) => new Request(new URL(path, ORIGIN)));
  }

  async addAll(paths) {
    for (const path of paths) this.entries.set(path, new Response(path));
  }
}

test("service worker keeps one prior lazy bundle generation, then prunes it and old shells", async () => {
  const source = await readFile(new URL("public/sw.js", ROOT), "utf8");
  const handlers = new Map();
  const cachesByName = new Map();
  const caches = {
    async open(name) {
      let cache = cachesByName.get(name);
      if (!cache) cachesByName.set(name, (cache = new MemoryCache()));
      return cache;
    },
    async keys() {
      return [...cachesByName.keys()];
    },
    async delete(name) {
      return cachesByName.delete(name);
    },
    async match(input) {
      for (const cache of cachesByName.values()) {
        const response = await cache.match(input);
        if (response) return response;
      }
      return undefined;
    },
  };
  let html = '<script src="/assets/old.abc.js"></script>';
  let fullAssets = ["/assets/current.def.js", "/assets/current-lazy.js"];
  const failures = new Set();
  const context = {
    URL,
    Request,
    Response,
    Promise,
    Set,
    Number,
    JSON,
    caches,
    self: {
      location: { origin: ORIGIN },
      clients: { async matchAll() { return []; }, async claim() {}, async get() { return null; } },
      addEventListener(type, handler) { handlers.set(type, handler); },
      async skipWaiting() {},
    },
    async fetch(input) {
      const path = new URL(typeof input === "string" ? input : input.url, ORIGIN).pathname;
      if (failures.has(path)) return new Response("failed", { status: 503 });
      if (path === "/asset-manifest.json") return Response.json({ assets: fullAssets });
      if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
      if (path.startsWith("/assets/")) return new Response(path);
      return new Response("missing", { status: 404 });
    },
  };
  vm.runInNewContext(source, context);

  const active = await caches.open("moting-shell-v15");
  await active.put("/__shell-assets.json", new Response(JSON.stringify(["/assets/old.abc.js"])));
  await active.put("/assets/old.abc.js", new Response("old bundle"));
  await active.put("/", new Response('<script src="/assets/old.abc.js"></script>'));

  await active.put("/assets/old-lazy.js", new Response("old lazy bundle"));

  const checkUpdate = async () => {
    let pending;
    handlers.get("message")({
      data: { type: "check-update" },
      source: { postMessage() {} },
      waitUntil(promise) { pending = promise; },
    });
    await pending;
  };

  html = '<script src="/assets/current.def.js"></script>';
  failures.add("/assets/current-lazy.js");
  await checkUpdate();
  assert.match(await (await active.match("/")).text(), /old.abc.js/, "failed precache must keep old shell");
  assert.ok(await active.match("/assets/old-lazy.js"));
  failures.clear();
  await Promise.all([checkUpdate(), checkUpdate()]);
  assert.ok(await active.match("/assets/old-lazy.js"), "old lazy chunks absent from HTML survive migration");
  assert.ok(await active.match("/assets/current-lazy.js"), "new lazy chunks are precached for offline use");
  assert.ok(await active.match("/assets/old.abc.js"), "open old tabs can still load a lazy chunk");
  assert.ok(await active.match("/assets/current.def.js"));

  html = '<script src="/assets/next.ghi.js"></script>';
  fullAssets = ["/assets/next.ghi.js", "/assets/next-lazy.js"];
  await checkUpdate();
  assert.equal(await active.match("/assets/old.abc.js"), undefined, "only one old generation is retained");
  assert.equal(await active.match("/assets/old-lazy.js"), undefined);
  assert.ok(await active.match("/assets/current-lazy.js"));
  assert.ok(await active.match("/assets/current.def.js"));
  assert.ok(await active.match("/assets/next.ghi.js"));
  assert.ok(await active.match("/assets/next-lazy.js"));
  fullAssets = ["/assets/mismatched.js"];
  await checkUpdate();
  assert.ok(await active.match("/assets/current-lazy.js"), "mismatched manifests cannot prune working assets");

  await caches.open("moting-shell-v13");
  await caches.open("moting-shell-v14");
  await caches.open("unrelated-cache");
  let activation;
  handlers.get("activate")({ waitUntil(promise) { activation = promise; } });
  await activation;
  assert.deepEqual(await caches.keys(), ["moting-shell-v15", "moting-shell-v14", "unrelated-cache"]);
});
