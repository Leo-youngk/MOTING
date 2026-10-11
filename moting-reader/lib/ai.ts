import type { AiChatTurn } from "./types";
import { aiStreamEvents } from "./ai-stream.ts";

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

/**
 * 错误响应里的那句人话。Worker 已统一成 `{"error":{"message"}}`，保险起见也认 Gemini
 * 兼容接口那种外面包一层数组的 `[{"error":{…}}]`——不认的话用户只看得到一个状态码。
 */
async function errorMessage(response: Response): Promise<string | undefined> {
  const detail: unknown = await response.json().catch(() => null);
  const record = (Array.isArray(detail) ? detail[0] : detail) as
    | { error?: { message?: unknown } }
    | null
    | undefined;
  const message = record?.error?.message;
  return typeof message === "string" && message ? message : undefined;
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
    throw new AiRequestError((await errorMessage(response)) ?? `获取模型列表失败（${response.status}）`);
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
  /** 主模型忙（503、限流）时 Worker 自动改用它答；空串表示不设备用。 */
  fallbackModel?: string;
  messages: AiChatMessage[];
  deepThinking: boolean;
  signal?: AbortSignal;
  /** 开始出字时告诉调用方是哪个模型在答：主模型忙时 Worker 会换成备用模型，界面要标出来。 */
  onModel?: (model: string) => void;
}

/** 超过输出长度上限时续写一次；断线保留正文并报告失败，不把半截回答当完成。 */
export async function streamAiChat(options: AiChatOptions, onDelta: (delta: AiStreamDelta) => void): Promise<void> {
  const { baseUrl, apiKey, fallbackModel, deepThinking, signal } = options;
  let messages = options.messages;
  let model = options.model;
  let content = "";
  for (let continuation = 0; continuation <= 1; continuation++) {
    let response: Response;
    try {
      response = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl, apiKey, model, fallbackModel, messages, deepThinking }),
        signal,
      });
    } catch (err) {
      if (signal?.aborted || (err as Error)?.name === "AbortError") throw err;
      throw new AiRequestError(content ? "回答中途断开，已保留收到的内容，可继续回答" : "连不上服务器，稍后再试");
    }
    if (!response.ok || !response.body) {
      throw new AiRequestError((await errorMessage(response)) ?? `AI 服务返回 ${response.status}`);
    }
    model = response.headers.get("x-ai-model") || model;
    options.onModel?.(model);
    let answered = false;
    let ended = false;
    let finishReason = "";
    try {
      for await (const event of aiStreamEvents(response.body, signal)) {
        if (event.error) throw new AiRequestError(event.error.message);
        if (event.content?.trim()) answered = true;
        content += event.content ?? "";
        if (event.content || event.reasoning) onDelta({ content: event.content, reasoning: event.reasoning });
        if (event.finishReason) finishReason = event.finishReason;
        if (event.done || event.finishReason) {
          ended = true;
          break;
        }
      }
    } catch (err) {
      if (err instanceof AiRequestError || signal?.aborted) throw err;
      throw new AiRequestError(content ? "回答中途断开或长时间没有输出，已保留收到的内容，可继续回答" : "AI 长时间没有返回回答，请重试");
    }
    if (finishReason === "content_filter") throw new AiRequestError("AI 服务拦截了这次回答，请调整提问");
    if (finishReason && finishReason !== "stop" && finishReason !== "length") {
      throw new AiRequestError("模型提前结束了回答，已保留收到的内容，可继续回答");
    }
    if (!answered) throw new AiRequestError("AI 这次没有给出回答，请重试");
    if (!ended) throw new AiRequestError("回答中途断开，已保留收到的内容，可继续回答");
    if (finishReason !== "length") return;
    if (continuation || content.length > AI_REQUEST_LIMITS.messageChars || messages.length + 2 > AI_REQUEST_LIMITS.messages) {
      throw new AiRequestError("回答达到输出长度上限，已保留收到的内容，可继续回答");
    }
    messages = [...messages, { role: "assistant", content },
      { role: "user", content: "请从中断处继续完成回答，不要重复已经给出的内容。" }];
  }
}
