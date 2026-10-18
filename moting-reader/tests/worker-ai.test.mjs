import assert from "node:assert/strict";
import test from "node:test";
import worker from "../dist/server/index.js";

const payload = {
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  apiKey: "fixture-key", model: "gemini-3.8-flash", fallbackModel: "gemini-3.5-flash-lite",
  messages: [{ role: "user", content: "测试问题" }], deepThinking: false,
};
const request = body => new Request("https://moting.example/api/ai/chat", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

test("the built Worker retries HTTP 200 errors and returns only the fallback answer", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    assert.equal(url, `${payload.baseUrl}/chat/completions`);
    assert.equal(body.enable_thinking, undefined);
    assert.equal(body.reasoning_effort, "low");
    return new Response(body.model === payload.model
      ? 'data: [{"error":{"code":429,"message":"Quota exhausted","details":[{"retryDelay":"60s"}]}}]\n\n'
      : 'data: {"choices":[{"delta":{"content":"备用模型完整回答"},"finish_reason":"stop"}]}\n\n');
  };
  try {
    const response = await worker.fetch(request(payload), {}, {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-ai-model"), payload.fallbackModel);
    assert.match(await response.text(), /备用模型完整回答/);
    assert.deepEqual(calls.map(call => call.model), [payload.model, payload.fallbackModel]);
  } finally { globalThis.fetch = original; }
});

test("the built Worker returns a useful error when the free daily quota is exhausted", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('[{"error":{"code":429,"message":"RequestsPerDay quota exhausted"}}]', { status: 429 });
  };
  try {
    const response = await worker.fetch(request({ ...payload, fallbackModel: "" }), {}, {});
    assert.equal(response.status, 429);
    assert.match((await response.json()).error.message, /当天额度已用完/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test("the built Worker preserves a truncated reply and reports interruption in the stream", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('data: {"choices":[{"delta":{"content":"半截正文"}}]}\n\n');
  };
  try {
    const response = await worker.fetch(request(payload), {}, {});
    const body = await response.text();
    assert.match(body, /半截正文/);
    assert.match(body, /回答中途断开/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

const crossPayload = {
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  apiKey: "primary-fixture", model: "gemini-3.8-flash", deepThinking: true,
  fallbackProvider: { baseUrl: "https://api.deepseek.com", apiKey: "backup-fixture", model: "gemini-3.8-flash" },
  messages: [{ role: "user", content: "测试问题" }],
};
function crossRequest(body, path = "/api/ai/chat") {
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
    const response = await worker.fetch(crossRequest(crossPayload), {}, {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-ai-provider"), "fallback");
    assert.equal(response.headers.get("x-ai-model"), "gemini-3.8-flash");
    assert.match(await response.text(), /备用回答/);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].url, `${crossPayload.baseUrl}/chat/completions`);
    assert.equal(calls[0].authorization, "Bearer primary-fixture");
    assert.equal(calls[0].body.extra_body.google.thinking_config.thinking_level, "high");
    assert.equal(calls[0].body.enable_thinking, undefined);
    assert.equal(calls[2].authorization, "Bearer backup-fixture");
    assert.deepEqual(calls[2].body.thinking, { type: "enabled" });
    assert.deepEqual(calls[2].body.messages, crossPayload.messages);
  } finally { globalThis.fetch = original; }
});

test("invalid backup URLs are rejected before any upstream crossRequest", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("must not be called"); };
  try {
    for (const baseUrl of ["http://example.com/v1", "https://127.0.0.1/v1", "https://10.0.0.1/v1"]) {
      const response = await worker.fetch(crossRequest({ ...crossPayload,
        fallbackProvider: { ...crossPayload.fallbackProvider, baseUrl },
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
    const response = await worker.fetch(crossRequest(crossPayload.fallbackProvider, "/api/ai/models"), {}, {});
    assert.deepEqual(await response.json(), { data: [{ id: "available-model" }] });
  } finally { globalThis.fetch = original; }
});
