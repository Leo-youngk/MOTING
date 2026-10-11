import assert from "node:assert/strict";
import test from "node:test";
import { AI_REQUEST_LIMITS, AiRequestError, modelHistory, streamAiChat } from "../lib/ai.ts";
import type { AiChatTurn } from "../lib/types.ts";

test("empty answers are dropped and the questions around them merged", () => {
  const turns: AiChatTurn[] = [
    { role: "user", content: "啥意思？", quote: "原文一句" },
    { role: "assistant", content: "" },
    { role: "user", content: "？" },
    { role: "assistant", content: "这句话是说……" },
  ];
  assert.deepEqual(modelHistory(turns), [
    { role: "user", content: "引用原文：\n原文一句\n\n啥意思？\n\n？" },
    { role: "assistant", content: "这句话是说……" },
  ]);
});

test("a long conversation only sends the recent rounds", () => {
  const turns: AiChatTurn[] = [];
  for (let i = 0; i < 60; i++) {
    turns.push({ role: "user", content: `问题${i}` }, { role: "assistant", content: `回答${i}` });
  }
  turns.push({ role: "user", content: "最后一问" });
  const messages = modelHistory(turns);
  // 加上系统提示也不能顶到转发的条数上限
  assert.ok(messages.length + 1 <= AI_REQUEST_LIMITS.messages);
  assert.equal(messages[0].role, "user");
  assert.equal(messages.at(-1)?.content, "最后一问");
});

test("the history stays within the size limits and keeps the current question", () => {
  const big = "字".repeat(25000);
  const turns: AiChatTurn[] = [
    { role: "user", content: "最早的一问" },
    { role: "assistant", content: big },
    { role: "user", content: big },
    { role: "assistant", content: big },
    { role: "user", content: big },
  ];
  const messages = modelHistory(turns);
  assert.ok(messages.every((message) => message.content.length <= AI_REQUEST_LIMITS.messageChars));
  assert.ok(messages.reduce((sum, message) => sum + message.content.length, 0) < AI_REQUEST_LIMITS.totalChars);
  assert.equal(messages[0].role, "user");
  assert.equal(messages.at(-1)?.content, big.slice(0, AI_REQUEST_LIMITS.messageChars));
  assert.ok(!messages.some((message) => message.content === "最早的一问"));
});

function sse(chunks: string[], headers: Record<string, string> = {}) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream", ...headers } }
  );
}

const options = { baseUrl: "https://example.com/v1", apiKey: "", model: "m", messages: [], deepThinking: false };

async function withFetch(response: Response, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("an error sent inside the stream is reported instead of an empty answer", async () => {
  await withFetch(sse(['data: {"error":{"message":"模型过载，稍后再试"}}\n\n']), async () => {
    await assert.rejects(
      streamAiChat(options, () => {}),
      (error) => error instanceof AiRequestError && error.message === "模型过载，稍后再试"
    );
  });
});

test("a stream that ends without any answer text is an error", async () => {
  const chunks = ['data: {"choices":[{"delta":{"reasoning_content":"想一想"}}]}\n\n', "data: [DONE]\n\n"];
  await withFetch(sse(chunks), async () => {
    await assert.rejects(streamAiChat(options, () => {}), AiRequestError);
  });
});

test("a normal stream delivers the answer piece by piece", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"con',
    'tent":"好"}}]}\n\n',
    "data: [DONE]\n\n",
  ];
  await withFetch(sse(chunks), async () => {
    let text = "";
    await streamAiChat(options, (delta) => {
      text += delta.content ?? "";
    });
    assert.equal(text, "你好");
  });
});

test("the model that actually answered is reported, so a fallback answer can be labelled", async () => {
  const chunks = ['data: {"choices":[{"delta":{"content":"好"}}]}\n\n', "data: [DONE]\n\n"];
  await withFetch(sse(chunks, { "x-ai-model": "gemini-3.7-flash" }), async () => {
    let model = "";
    await streamAiChat({ ...options, onModel: (answeredBy) => (model = answeredBy) }, () => {});
    assert.equal(model, "gemini-3.7-flash");
  });
});

test("an error body wrapped in an array still shows its message", async () => {
  const body = '[{"error":{"code":503,"message":"模型过载"}}]';
  await withFetch(new Response(body, { status: 503 }), async () => {
    await assert.rejects(
      streamAiChat(options, () => {}),
      (error) => error instanceof AiRequestError && error.message === "模型过载"
    );
  });
});

test("an array-wrapped error inside HTTP 200 keeps the upstream reason", async () => {
  await withFetch(sse(['data: [{"error":{"code":503,"message":"模型过载"}}]\n\n']), async () => {
    await assert.rejects(streamAiChat(options, () => {}), /模型过载/);
  });
});

test("EOF after partial output is reported and the partial text is preserved", async () => {
  await withFetch(sse(['data: {"choices":[{"delta":{"content":"半截"}}]}\n\n']), async () => {
    let text = "";
    await assert.rejects(streamAiChat(options, delta => { text += delta.content ?? ""; }), /中途断开/);
    assert.equal(text, "半截");
  });
});

test("finish_reason stop is accepted even when the provider omits DONE", async () => {
  await withFetch(sse(['data: {"choices":[{"delta":{"content":"完整"},"finish_reason":"stop"}]}\r\n\r\n']), async () => {
    let text = "";
    await streamAiChat(options, delta => { text += delta.content ?? ""; });
    assert.equal(text, "完整");
  });
});

test("length-limited output continues once with the existing answer as context", async () => {
  const original = globalThis.fetch;
  const requests: { messages: { role: string; content: string }[] }[] = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return requests.length === 1
      ? sse(['data: {"choices":[{"delta":{"content":"开头"},"finish_reason":"length"}]}\n\n'])
      : sse(['data: {"choices":[{"delta":{"content":"结尾"},"finish_reason":"stop"}]}\n\n']);
  };
  try {
    let text = "";
    await streamAiChat(options, delta => { text += delta.content ?? ""; });
    assert.equal(text, "开头结尾");
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].messages.at(-2), { role: "assistant", content: "开头" });
    assert.match(requests[1].messages.at(-1)!.content, /不要重复/);
  } finally { globalThis.fetch = original; }
});

test("continuation is bounded and content filtering is reported", async () => {
  for (const reason of ["length", "content_filter"]) {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls++; return sse([`data: {"choices":[{"delta":{"content":"部分"},"finish_reason":"${reason}"}]}\n\n`]); };
    try {
      await assert.rejects(streamAiChat(options, () => {}), reason === "length" ? /长度上限/ : /拦截/);
      assert.equal(calls, reason === "length" ? 2 : 1);
    } finally { globalThis.fetch = original; }
  }
});

test("canceling an active reply cancels the upstream reader", async () => {
  const controller = new AbortController();
  let canceled = false;
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream({
    start(stream) { stream.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"开头"}}]}\n\n')); },
    cancel() { canceled = true; },
  }));
  await withFetch(response, async () => {
    await assert.rejects(streamAiChat({ ...options, signal: controller.signal }, () => controller.abort()));
  });
  assert.equal(canceled, true);
});

test("unexpected tool completion is not mistaken for a complete text reply", async () => {
  await withFetch(sse(['data: {"choices":[{"delta":{"content":"部分"},"finish_reason":"tool_calls"}]}\n\n']), async () => {
    await assert.rejects(streamAiChat(options, () => {}), /提前结束/);
  });
});
