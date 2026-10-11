import assert from "node:assert/strict";
import test from "node:test";
import {
  aiAttemptPlan,
  aiFailureMessage,
  aiThinkingOptions,
  requestWithRetry,
  retryAfterMs,
  upstreamErrorMessage,
} from "../worker/ai-upstream.ts";

const OVERLOADED = '[{"error":{"code":503,"message":"The model is overloaded.","status":"UNAVAILABLE"}}]';

function reply(status: number, body = "") {
  return new Response(status === 200 ? 'data: {"choices":[{"delta":{"content":"回答"}}]}\n\ndata: [DONE]\n\n' : body, { status });
}

/** 按顺序吐出预设的响应，并记下每次请求的是哪个模型。 */
function scripted(responses: Array<number | Error>) {
  const models: string[] = [];
  const send = async (model: string) => {
    models.push(model);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return reply(next ?? 200, next === 200 ? "" : OVERLOADED);
  };
  return { send, models };
}

function harness() {
  const waits: number[] = [];
  return {
    waits,
    wait: async (ms: number) => {
      waits.push(Math.round(ms));
    },
    random: () => 0.5,
    readError: (response: Response) => response.text(),
    signal: new AbortController().signal,
    budgetMs: 30000,
  };
}

test("a busy primary model hands over to the fallback model", async () => {
  const h = harness();
  const { send, models } = scripted([503, 503, 200]);
  const result = await requestWithRetry({ ...h, send, plan: aiAttemptPlan("lite", "flash") });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.model, "flash");
  assert.deepEqual(models, ["lite", "lite", "flash"]);
  // 主模型重试前等约 1 秒，换备用模型不用等
  assert.deepEqual(h.waits, [1000]);
});

test("HTTP 200 with an empty answer or array-wrapped stream error is retried before output", async () => {
  const models: string[] = [];
  const responses = [new Response("data: [DONE]\n\n"), new Response(`data: ${OVERLOADED}\n\n`), reply(200)];
  const result = await requestWithRetry({ ...harness(), plan: aiAttemptPlan("primary", "fallback"),
    send: async model => { models.push(model); return responses.shift()!; } });
  assert.equal(result.ok && result.model, "fallback");
  assert.deepEqual(models, ["primary", "primary", "fallback"]);
  if (result.ok) assert.match(await result.response.text(), /回答/);
});

test("a stalled first answer is canceled and switches to the fallback within the budget", async () => {
  const models: string[] = [];
  let canceled = false;
  const result = await requestWithRetry({ ...harness(), budgetMs: 500, attemptTimeoutMs: 20,
    plan: aiAttemptPlan("primary", "fallback"),
    send: async model => {
      models.push(model);
      return model === "fallback" ? reply(200) : new Response(new ReadableStream({ cancel() { canceled = true; } }));
    } });
  assert.equal(result.ok && result.model, "fallback");
  assert.deepEqual(models, ["primary", "fallback"]);
  assert.equal(canceled, true);
  if (result.ok) await result.response.text();
});

test("the startup budget also bounds waiting for HTTP headers", async () => {
  const started = Date.now();
  let upstreamSignal: AbortSignal | undefined;
  const result = await requestWithRetry({ ...harness(), budgetMs: 30,
    plan: [{ model: "primary", delayMs: 0 }],
    send: async (_model, signal) => { upstreamSignal = signal; return new Promise(() => {}); } });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 408);
  assert.equal(upstreamSignal?.aborted, true);
  assert.ok(Date.now() - started < 300);
});

test("a partial reply is preserved and interrupted instead of retried", async () => {
  let calls = 0;
  const outcomes: string[] = [];
  const result = await requestWithRetry({ ...harness(), plan: aiAttemptPlan("primary", "fallback"),
    send: async () => { calls++; return new Response('data: {"choices":[{"delta":{"content":"半截回答"}}]}\n\n'); },
    onStreamEnd: (_model, outcome) => outcomes.push(outcome) });
  assert.equal(result.ok, true);
  if (result.ok) {
    const text = await result.response.text();
    assert.match(text, /半截回答/);
    assert.match(text, /回答中途断开/);
  }
  assert.equal(calls, 1);
  assert.deepEqual(outcomes, ["interrupted"]);
});

test("idle output times out but a steadily producing long answer stays open", async () => {
  const encoder = new TextEncoder();
  for (const stalled of [true, false]) {
    let timer: ReturnType<typeof setInterval>;
    let canceled = false;
    let count = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"开头"}}]}\n\n'));
        if (!stalled) timer = setInterval(() => {
          controller.enqueue(encoder.encode(++count === 8 ? "data: [DONE]\n\n" : 'data: {"choices":[{"delta":{"content":"继续"}}]}\n\n'));
          if (count === 8) { clearInterval(timer); controller.close(); }
        }, 10);
      },
      cancel() { clearInterval(timer); canceled = true; },
    });
    const result = await requestWithRetry({ ...harness(), budgetMs: 50, idleMs: 30,
      plan: [{ model: "primary", delayMs: 0 }], send: async () => new Response(body) });
    assert.equal(result.ok, true);
    if (result.ok) {
      const text = await result.response.text();
      assert.equal(text.includes("回答中途断开"), stalled);
      assert.equal(text.includes("[DONE]"), !stalled);
    }
    if (stalled) assert.equal(canceled, true);
  }
});

test("429 respects Retry-After and can immediately use a different model", async () => {
  const h = harness();
  const models: string[] = [];
  const result = await requestWithRetry({ ...h, plan: aiAttemptPlan("primary", "fallback"),
    send: async model => {
      models.push(model);
      return model === "primary" ? new Response(OVERLOADED, { status: 429, headers: { "retry-after": "60" } }) : reply(200);
    } });
  assert.deepEqual(models, ["primary", "fallback"]);
  assert.deepEqual(h.waits, []);
  assert.equal(result.ok, true);
  if (result.ok) await result.response.text();
  assert.equal(retryAfterMs("60", "", 0), 60000);
  assert.equal(retryAfterMs("Thu, 01 Jan 1970 00:01:00 GMT", "", 10000), 50000);
  assert.equal(retryAfterMs(null, '[{"error":{"details":[{"retryDelay":"60s"}]}}]', 0), 60000);
  assert.equal(retryAfterMs(null, '{"error":{"message":"RequestsPerDay quota exhausted"}}', 0), 86400000);
});

test("Google gets supported reasoning settings without affecting other providers", () => {
  const google = "https://generativelanguage.googleapis.com/v1beta/openai";
  assert.deepEqual(aiThinkingOptions(google, "models/gemini-2.5-flash", false), { reasoning_effort: "none" });
  assert.deepEqual(aiThinkingOptions(google, "models/gemini-3.8-flash", false), { reasoning_effort: "low" });
  assert.deepEqual(aiThinkingOptions(google, "models/gemini-3.8-flash", true),
    { extra_body: { google: { thinking_config: { thinking_level: "high", include_thoughts: true } } } });
  assert.deepEqual(aiThinkingOptions(google, "gemini-2.0-flash", false), {});
  assert.deepEqual(aiThinkingOptions("https://other.example/v1", "m", true), { enable_thinking: true });
});

test("reasoning-only responses are retried without leaking failed thoughts", async () => {
  let calls = 0;
  const result = await requestWithRetry({ ...harness(), plan: aiAttemptPlan("primary", null),
    send: async () => ++calls === 1
      ? new Response('data: {"choices":[{"delta":{"reasoning_content":"失败的思考"}}]}\n\ndata: [DONE]\n\n')
      : reply(200) });
  assert.equal(result.ok, true);
  if (result.ok) assert.doesNotMatch(await result.response.text(), /失败的思考/);
  assert.equal(calls, 2);
});

test("Retry-After longer than the budget avoids repeating requests to the same model", async () => {
  let calls = 0;
  const result = await requestWithRetry({ ...harness(), plan: aiAttemptPlan("primary", null),
    send: async () => { calls++; return new Response("limited", { status: 429, headers: { "retry-after": "60" } }); } });
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
});

test("forwarding preserves multiline SSE and cancels an active upstream on client cancellation", async () => {
  let canceled = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode('data: {"choices":\ndata: [{"delta":{"content":"正文"}}]}\n\n')); },
    cancel() { canceled = true; },
  });
  const result = await requestWithRetry({ ...harness(), plan: aiAttemptPlan("primary", null), send: async () => new Response(body) });
  assert.equal(result.ok, true);
  if (result.ok) {
    const reader = result.response.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /\ndata: \[/);
    await reader.cancel();
  }
  assert.equal(canceled, true);
});

test("a single retry is enough when the model recovers", async () => {
  const h = harness();
  const { send, models } = scripted([503, 200]);
  const result = await requestWithRetry({ ...h, send, plan: aiAttemptPlan("lite", "flash") });
  assert.equal(result.ok && result.model, "lite");
  assert.deepEqual(models, ["lite", "lite"]);
  assert.deepEqual(result.attempts, [
    { model: "lite", status: 503 },
    { model: "lite", status: 200 },
  ]);
});

test("configuration errors are reported at once, without retries or fallback", async () => {
  const h = harness();
  const { send, models } = scripted([400]);
  const result = await requestWithRetry({ ...h, send, plan: aiAttemptPlan("lite", "flash") });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 400);
  assert.deepEqual(models, ["lite"]);
});

test("without a fallback the primary model is retried with growing pauses", async () => {
  const h = harness();
  const { send, models } = scripted([503, 503, 503, 503]);
  const result = await requestWithRetry({ ...h, send, plan: aiAttemptPlan("lite", null) });
  assert.equal(result.ok, false);
  assert.deepEqual(models, ["lite", "lite", "lite", "lite"]);
  assert.deepEqual(h.waits, [1000, 2000, 4000]);
});

test("retries stop once the time budget is used up", async () => {
  const h = harness();
  let clock = 0;
  const { send, models } = scripted([503, 503, 503, 503, 503]);
  const result = await requestWithRetry({
    ...h,
    budgetMs: 5000,
    now: () => clock,
    send: async (model) => {
      clock += 3000; // 一次 503 本身就要三秒上下
      return send(model);
    },
    plan: aiAttemptPlan("lite", "flash"),
  });
  assert.equal(result.ok, false);
  assert.ok(models.length < 5, `试了 ${models.length} 次`);
});

test("closing the chat while waiting stops the retries", async () => {
  const controller = new AbortController();
  const { send, models } = scripted([503, 200]);
  await assert.rejects(
    requestWithRetry({
      plan: aiAttemptPlan("lite", "flash"),
      send,
      readError: (response) => response.text(),
      signal: controller.signal,
      budgetMs: 30000,
      wait: async () => {
        controller.abort();
        throw controller.signal.reason;
      },
    })
  );
  assert.deepEqual(models, ["lite"]);
});

test("a dropped connection counts as a retryable failure", async () => {
  const h = harness();
  const { send } = scripted([new TypeError("network"), 200]);
  const result = await requestWithRetry({ ...h, send, plan: aiAttemptPlan("lite", null) });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attempts, [
    { model: "lite", status: 0 },
    { model: "lite", status: 200 },
  ]);
});

test("error bodies are read in both the OpenAI and the Gemini array format", () => {
  assert.equal(upstreamErrorMessage(OVERLOADED), "The model is overloaded.");
  assert.equal(upstreamErrorMessage('{"error":{"message":"Invalid key"}}'), "Invalid key");
  assert.equal(upstreamErrorMessage("upstream timeout"), "upstream timeout");
  assert.equal(upstreamErrorMessage("<html><body>502</body></html>"), "");
  assert.equal(upstreamErrorMessage(""), "");
});

test("the final error says what happened in plain Chinese", () => {
  const withFallback = aiFailureMessage(
    503,
    [
      { model: "lite", status: 503 },
      { model: "lite", status: 503 },
      { model: "flash", status: 503 },
    ],
    OVERLOADED
  );
  assert.match(withFallback, /太忙（503）/);
  assert.match(withFallback, /备用模型 flash 也没接上/);

  const alone = aiFailureMessage(503, [
    { model: "lite", status: 503 },
    { model: "lite", status: 503 },
  ], "");
  assert.match(alone, /在设置里填一个备用模型/);

  assert.equal(
    aiFailureMessage(400, [{ model: "lite", status: 400 }], '[{"error":{"message":"Please pass a valid API key"}}]'),
    "AI 服务拒绝了这次请求（400）：Please pass a valid API key"
  );
  assert.match(aiFailureMessage(0, [{ model: "lite", status: 0 }], ""), /连不上这个接口地址/);
  assert.match(aiFailureMessage(429, [], ""), /额度/);
});
