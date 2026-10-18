/** OpenAI / Gemini 兼容流，两端共用解析，避免把 HTTP 200 当作回答成功。 */
export interface AiStreamEvent {
  data: string;
  content?: string;
  reasoning?: string;
  finishReason?: string;
  done?: boolean;
  error?: { message: string; status: number; detail: string };
}

export function parseAiEvent(data: string): AiStreamEvent {
  const event: AiStreamEvent = { data };
  if (data === "[DONE]") return { ...event, done: true };
  try {
    const parsed = JSON.parse(data);
    const record = Array.isArray(parsed) ? parsed[0] : parsed;
    if (record?.error) {
      const error = record.error;
      event.error = {
        message: typeof error === "string" ? error : typeof error.message === "string" ? error.message : "AI 服务出错，稍后再试",
        status: Number(error.code) >= 400 && Number(error.code) <= 599 ? Number(error.code) : 502,
        detail: data,
      };
    }
    const choice = record?.choices?.[0];
    const delta = choice?.delta;
    if (typeof delta?.content === "string") event.content = delta.content;
    if (typeof delta?.reasoning_content === "string") event.reasoning = delta.reasoning_content;
    if (typeof choice?.finish_reason === "string") event.finishReason = choice.finish_reason;
  } catch {
    // 不完整或无关的事件不能算正文，也不能算正常结束。
  }
  return event;
}

/** 同时覆盖等响应头、读流和用户取消；超时只针对这一次等待，不截断持续输出。 */
export function waitForAi<T>(pending: Promise<T>, signal?: AbortSignal, timeoutMs = 0): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => finish(reject, signal?.reason ?? new DOMException("请求已取消", "AbortError"));
    const timer = timeoutMs > 0
      ? setTimeout(() => finish(reject, new DOMException("AI 长时间没有输出", "TimeoutError")), timeoutMs)
      : undefined;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const finish = (settle: typeof reject, value: unknown) => { cleanup(); settle(value); };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    pending.then(value => { cleanup(); resolve(value); }, error => finish(reject, error));
  });
}

export async function* aiStreamEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  idleMs = 45000,
): AsyncGenerator<AiStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  try {
    while (true) {
      const { done, value } = await waitForAi(reader.read(), signal, idleMs);
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length + data.join("\n").length > 1024 * 1024) throw new Error("AI 流事件过大");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      if (done && buffer) lines.push(buffer);
      for (const raw of lines) {
        const line = raw.replace(/\r$/, "");
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        else if (!line && data.length) {
          yield parseAiEvent(data.join("\n"));
          data = [];
        }
      }
      if (done) {
        if (data.length) yield parseAiEvent(data.join("\n"));
        return;
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
