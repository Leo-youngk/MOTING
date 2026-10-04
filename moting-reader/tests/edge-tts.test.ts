import assert from "node:assert/strict";
import test from "node:test";

import { pickStableWindowsVersion } from "../worker/edge-tts.ts";
import type { EdgeProduct } from "../worker/edge-tts.ts";

const products: EdgeProduct[] = [
  {
    Product: "Beta",
    Releases: [
      {
        Platform: "Windows",
        Architecture: "x64",
        ProductVersion: "151.0.4100.1",
      },
    ],
  },
  {
    Product: "Stable",
    Releases: [
      {
        Platform: "MacOS",
        Architecture: "universal",
        ProductVersion: "150.0.4078.100",
      },
      {
        Platform: "Windows",
        Architecture: "arm64",
        ProductVersion: "150.0.4078.104",
      },
      {
        Platform: "Windows",
        Architecture: "x64",
        ProductVersion: "150.0.4078.105",
      },
    ],
  },
];

test("从更新接口里挑出 Windows x64 稳定版", () => {
  assert.equal(pickStableWindowsVersion(products), "150.0.4078.105");
});

test("缺少稳定版渠道时返回 null", () => {
  assert.equal(pickStableWindowsVersion([products[0]]), null);
});

test("版本号格式不合法时返回 null", () => {
  const malformed: EdgeProduct[] = [
    {
      Product: "Stable",
      Releases: [
        {
          Platform: "Windows",
          Architecture: "x64",
          ProductVersion: "150.0.4078.105'&x=",
        },
      ],
    },
  ];
  assert.equal(pickStableWindowsVersion(malformed), null);
});

test("streaming emits ordered Blob frames before turn.end and rejects truncated sockets", async () => {
  const { synthesizeSpeech } = await import("../worker/edge-tts.ts");
  const oldFetch = globalThis.fetch;
  const oldCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const sockets: EventTarget[] = [];
  let socketReady!: () => void;
  let ready = new Promise<void>(resolve => { socketReady = resolve; });
  class Socket extends EventTarget {
    accept() {}
    send() { socketReady(); }
    close() {}
  }
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { default: { match: async () => new Response("150.0.4078.105") } } });
  globalThis.fetch = async () => { const socket = new Socket(); sockets.push(socket); return { webSocket: socket } as unknown as Response; };
  const frame = (n: number) => new Blob([new Uint8Array([0, 0, n])]);
  try {
    const received: number[] = [];
    let delivered!: () => void;
    const first = new Promise<void>(resolve => { delivered = resolve; });
    const task = synthesizeSpeech("测试", "zh-CN-YunjianNeural", new AbortController().signal, async data => { received.push(data[0]); delivered(); });
    await ready;
    sockets[0].dispatchEvent(new MessageEvent("message", { data: frame(1) }));
    await first;
    assert.deepEqual(received, [1], "audio must be delivered before turn.end");
    sockets[0].dispatchEvent(new MessageEvent("message", { data: frame(2) }));
    sockets[0].dispatchEvent(new MessageEvent("message", { data: "Path:turn.end\r\n\r\n" }));
    assert.deepEqual((await task).audio, new Uint8Array([1, 2]));
    assert.deepEqual(received, [1, 2]);
    ready = new Promise<void>(resolve => { socketReady = resolve; });
    const truncated = synthesizeSpeech("测试", "zh-CN-YunjianNeural", new AbortController().signal);
    const rejection = assert.rejects(truncated, /提前关闭/);
    await ready;
    sockets[1].dispatchEvent(new MessageEvent("message", { data: frame(1) }));
    sockets[1].dispatchEvent(new Event("close"));
    await rejection;
  } finally {
    globalThis.fetch = oldFetch;
    if (oldCaches) Object.defineProperty(globalThis, "caches", oldCaches);
    else Reflect.deleteProperty(globalThis, "caches");
  }
});
