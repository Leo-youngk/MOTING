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

export async function fetchAiModels(baseUrl: string, apiKey: string): Promise<string[]> {
  let response: Response;
  try {
    response = await fetch("/api/ai/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl, apiKey }),
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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return;
      let parsed: {
        choices?: { delta?: { content?: string; reasoning_content?: string } }[];
      } | null = null;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = parsed?.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content || delta.reasoning_content) {
        onDelta({ content: delta.content, reasoning: delta.reasoning_content });
      }
    }
  }
}
