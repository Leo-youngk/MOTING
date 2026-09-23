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

function sse(chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
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
