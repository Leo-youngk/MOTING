import type { AiChatTurn } from "./types.ts";

export const CONTINUE_ANSWER = "请从中断处继续完成回答，不要重复已经给出的内容。";

/** 一次提问有了正文回答才算一轮。同一问题的重试、续写都归在原来那一轮。 */
export function summarizeChat(turns: readonly unknown[]) {
  const questions = new Set<string | number>();
  const answered = new Set<string | number>();
  let current: string | number | undefined;
  let previousWasPartial = false;
  let lastQuestion = "";

  turns.forEach((value, index) => {
    if (!value || typeof value !== "object") return;
    const turn = value as Partial<AiChatTurn>;
    if (typeof turn.content !== "string") return;
    if (turn.role === "user") {
      current = turn.id ?? index;
      // 旧版没有 continuation 字段，在半截回答后用固定的指令续写。
      const legacyContinue = previousWasPartial && !turn.quote && turn.content === CONTINUE_ANSWER;
      if (!turn.continuation && !legacyContinue && turn.content.trim()) {
        questions.add(current);
        lastQuestion = turn.content;
      }
    } else if (turn.role === "assistant" && turn.content.trim()) {
      const target = turn.replyTo ?? current;
      if (target !== undefined) answered.add(target);
    }
    previousWasPartial = turn.role === "assistant" && Boolean(turn.error && turn.content.trim());
  });

  let rounds = 0;
  for (const question of questions) if (answered.has(question)) rounds++;
  return { rounds, lastQuestion };
}
