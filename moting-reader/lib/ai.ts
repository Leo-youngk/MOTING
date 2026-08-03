/**
 * 直接从浏览器打到用户自己填的 OpenAI 兼容接口，不经过我们的 Worker——
 * 密钥只留在用户设备上。代价是遇到不支持 CORS 的服务商会连不上，
 * 这是接受的取舍，不在这里加代理兜底。
 */
export class AiRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiRequestError";
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

export async function fetchAiModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const url = `${normalizeBaseUrl(baseUrl)}/models`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    });
  } catch {
    throw new AiRequestError("连不上这个接口地址，检查地址或跨域设置");
  }
  if (!response.ok) {
    throw new AiRequestError(`获取模型列表失败（${response.status}）`);
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
  const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        ...(deepThinking ? { enable_thinking: true } : {}),
      }),
      signal,
    });
  } catch {
    throw new AiRequestError("连不上这个接口地址，检查地址或跨域设置");
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
