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
