import assert from "node:assert/strict";
import test from "node:test";
import { CONTINUE_ANSWER, summarizeChat } from "../lib/chat-rounds.ts";

const question = (id, content = "相同的问题") => ({ role: "user", id, content });
const answer = (replyTo, content = "回答") => ({ role: "assistant", replyTo, content });

test("count answered questions once across retries and out-of-order replies", () => {
  const turns = [answer("later"), question("first"), question("later"), answer("first"), answer("first"),
    question("pending"), { ...answer("pending", " "), reasoning: "思考中" }, answer("missing")];
  assert.equal(summarizeChat(turns).rounds, 2);
});

test("legacy and marked continuations belong to the original question", () => {
  const turns = [question(undefined), { ...answer(undefined), error: "中断" },
    question(undefined, CONTINUE_ANSWER), answer(undefined),
    { ...question("c", CONTINUE_ANSWER), continuation: true }, answer("c")];
  assert.deepEqual(summarizeChat(turns), { rounds: 1, lastQuestion: "相同的问题" });
});
