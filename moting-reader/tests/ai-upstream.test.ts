import assert from "node:assert/strict";
import test from "node:test";
import {
  aiAttemptPlan,
  aiFailureMessage,
  requestWithRetry,
  upstreamErrorMessage,
} from "../worker/ai-upstream.ts";

const OVERLOADED = '[{"error":{"code":503,"message":"The model is overloaded.","status":"UNAVAILABLE"}}]';

function reply(status: number, body = "") {
  return new Response(status === 200 ? "data: [DONE]\n\n" : body, { status });
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
