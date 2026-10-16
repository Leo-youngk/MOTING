import assert from "node:assert/strict";
import test from "node:test";
import worker from "../dist/server/index.js";

const payload = {
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  apiKey: "primary-fixture", model: "shared-model", deepThinking: true,
  fallbackProvider: { baseUrl: "https://api.deepseek.com", apiKey: "backup-fixture", model: "shared-model" },
  messages: [{ role: "user", content: "测试问题" }],
};
function request(body, path = "/api/ai/chat") {
  return new Request(`https://moting.example${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

test("built Worker switches both endpoint and key when the primary is busy", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const isBackup = url === "https://api.deepseek.com/chat/completions";
    calls.push({ url, authorization: init.headers.authorization, body });
    return new Response(isBackup
      ? 'data: {"choices":[{"delta":{"content":"备用回答"}}]}\n\ndata: [DONE]\n\n'
      : '{"error":{"message":"busy"}}', { status: isBackup ? 200 : 503 });
  };
  try {
    const response = await worker.fetch(request(payload), {}, {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-ai-provider"), "fallback");
    assert.equal(response.headers.get("x-ai-model"), "shared-model");
    assert.match(await response.text(), /备用回答/);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].url, `${payload.baseUrl}/chat/completions`);
    assert.equal(calls[0].authorization, "Bearer primary-fixture");
    assert.equal(calls[0].body.reasoning_effort, "high");
    assert.equal(calls[0].body.enable_thinking, undefined);
    assert.equal(calls[2].authorization, "Bearer backup-fixture");
    assert.deepEqual(calls[2].body.thinking, { type: "enabled" });
    assert.deepEqual(calls[2].body.messages, payload.messages);
  } finally { globalThis.fetch = original; }
});

test("invalid backup URLs are rejected before any upstream request", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("must not be called"); };
  try {
    for (const baseUrl of ["http://example.com/v1", "https://127.0.0.1/v1", "https://10.0.0.1/v1"]) {
      const response = await worker.fetch(request({ ...payload,
        fallbackProvider: { ...payload.fallbackProvider, baseUrl },
      }), {}, {});
      assert.equal(response.status, 400);
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test("model discovery uses the chosen provider credentials", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.deepseek.com/models");
    assert.equal(init.headers.authorization, "Bearer backup-fixture");
    return Response.json({ data: [{ id: "available-model" }] });
  };
  try {
    const response = await worker.fetch(request(payload.fallbackProvider, "/api/ai/models"), {}, {});
    assert.deepEqual(await response.json(), { data: [{ id: "available-model" }] });
  } finally { globalThis.fetch = original; }
});
