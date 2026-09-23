import type { AiChatTurn } from "./types";

/**
 * 请求经我们自己的 Worker 转发到用户填的 OpenAI 兼容接口——很多服务商的接口
 * 不带 CORS 响应头，浏览器直连会被拦，所以借道 Worker 做一次服务器到服务器的
 * 转发。Worker 只是原样转发、不持久化，但密钥会经过我们的服务器，这跟纯前端
 * 直连比是个取舍，用户已确认接受。
 */
export class AiRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiRequestError";
  }
}

export async function fetchAiModels(
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<string[]> {
  let response: Response;
  try {
    response = await fetch("/api/ai/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl, apiKey }),
      signal,
    });
  } catch {
    throw new AiRequestError("连不上服务器，稍后再试");
  }
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new AiRequestError(detail?.error?.message ?? `获取模型列表失败（${response.status}）`);
  }
  const body = (await response.json().catch(() => null)) as { data?: { id?: string }[] } | null;
  const ids = (body?.data ?? [])
    .map((item) => item.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) {
    throw new AiRequestError("这个接口没有返回可用模型");
  }
  return ids.sort();
}

export interface AiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Worker 转发一次请求的上限（worker/index.ts 按它校验，超了整个请求 400）。
 * 客户端按同一套数截历史：整本书聊得再久，一次请求也顶不到这里。
 */
export const AI_REQUEST_LIMITS = { messages: 50, messageChars: 20000, totalChars: 256000 } as const;

/** 历史只带最近这么多条、这么多字。再往前的，模型靠系统提示里的目录和当前章节兜底。 */
const HISTORY_MAX_MESSAGES = 30;
const HISTORY_MAX_CHARS = 60000;

/**
 * 常驻对话 → 发给模型的消息。
 * - 没答上来的空回答去掉（出错、被打断、模型什么都没给），它两边连在一起的两次提问
 *   并成一条，保持一问一答交替——有的服务商见到空的 assistant 或连续两条 user 会直接拒；
 * - 只带最近几轮，不会顶到转发的条数、字数上限。
 */
export function modelHistory(turns: AiChatTurn[]): AiChatMessage[] {
  const messages: AiChatMessage[] = [];
  for (const turn of turns) {
    const text = turn.role === "user" && turn.quote
      ? `引用原文：\n${turn.quote}\n\n${turn.content}`
      : turn.content;
    const content = text.trim();
    if (!content) continue;
    const last = messages[messages.length - 1];
    if (last?.role === turn.role) last.content += `\n\n${content}`;
    else messages.push({ role: turn.role, content });
  }
  let start = messages.length;
  let chars = 0;
  while (start > 0 && messages.length - start < HISTORY_MAX_MESSAGES) {
    const size = Math.min(messages[start - 1].content.length, AI_REQUEST_LIMITS.messageChars);
    // 最后一条（这次的提问）无论多长都得带上。
    if (start < messages.length && chars + size > HISTORY_MAX_CHARS) break;
    chars += size;
    start--;
  }
  const window = messages.slice(start);
  while (window.length > 1 && window[0].role !== "user") window.shift();
  return window.map((message) => ({
    ...message,
    content: message.content.slice(0, AI_REQUEST_LIMITS.messageChars),
  }));
}

export interface AiStreamDelta {
  content?: string;
  reasoning?: string;
}

export interface AiChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: AiChatMessage[];
  deepThinking: boolean;
  signal?: AbortSignal;
}

/** 逐块把增量内容喂给 onDelta，content 和 reasoning_content（深度思考）分开传。 */
export async function streamAiChat(options: AiChatOptions, onDelta: (delta: AiStreamDelta) => void): Promise<void> {
  const { baseUrl, apiKey, model, messages, deepThinking, signal } = options;

  let response: Response;
  try {
    response = await fetch("/api/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl, apiKey, model, messages, deepThinking }),
      signal,
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    throw new AiRequestError("连不上服务器，稍后再试");
  }

  if (!response.ok || !response.body) {
    const detail = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new AiRequestError(detail?.error?.message ?? `AI 服务返回 ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answered = false;

  const processLine = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return false;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") return true;
    let parsed: {
      choices?: { delta?: { content?: string; reasoning_content?: string } }[];
      error?: { message?: string };
    } | null = null;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return false;
    }
    // 有的服务商先回 200、再在流里塞一条错误（限流、过载），不接住就是一个空回答。
    if (parsed?.error) throw new AiRequestError(parsed.error.message || "AI 服务出错，稍后再试");
    const delta = parsed?.choices?.[0]?.delta;
    if (delta?.content) answered = true;
    if (delta && (delta.content || delta.reasoning_content)) {
      onDelta({ content: delta.content, reasoning: delta.reasoning_content });
    }
    return false;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      if (lines.some(processLine)) break;
      if (done) {
        if (buffer) processLine(buffer);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  // 连接正常结束却一个字都没给：多半是服务繁忙、被安全策略拦下，或者只返回了思考。
  if (!answered) throw new AiRequestError("AI 这次没有给出回答，可能是服务繁忙，点重试再来一次");
}
