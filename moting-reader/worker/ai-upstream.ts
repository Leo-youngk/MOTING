import { aiStreamEvents, waitForAi, type AiStreamEvent } from "../lib/ai-stream.ts";

/**
 * AI 转发的重试与备用模型。
 *
 * 上游（比如 Gemini）忙不过来时回 503「model overloaded」，这是它那边的算力问题，
 * 官方建议客户端退避重试——官方 SDK 默认就会重试，我们直连接口得自己来。
 * 只在正文开始输出之前重试；HTTP 200 的空流、流内报错也属于失败。
 */

/** 值得再试的状态：限流、超时和 5xx。400/401/404 这类是配置错了，重试也没用。 */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export interface AiAttemptStep {
  model: string;
  provider?: "fallback";
  /** 这一次开始前等多久（毫秒），实际再乘 0.8~1.2 的随机抖动。 */
  delayMs: number;
}

export interface AiAttempt {
  model: string;
  provider?: "fallback";
  /** 上游的 HTTP 状态；0 表示连不上或超时。 */
  status: number;
}

export type AiUpstreamResult =
  | { ok: true; response: Response; model: string; provider?: "fallback"; attempts: AiAttempt[] }
  | { ok: false; status: number; detail: string; attempts: AiAttempt[] };

/**
 * 主模型两次（间隔约 1 秒）→ 备用模型两次（约 1 秒）→ 主模型最后一次（约 2 秒）。
 * 忙起来往往一两分钟都缓不过来，主模型连着失败就早点换备用，比守着它等更快拿到回答。
 */
export function aiAttemptPlan(primary: string, fallback: string | null, crossProvider = false): AiAttemptStep[] {
  if (!fallback || (fallback === primary && !crossProvider)) {
    return [
      { model: primary, delayMs: 0 },
      { model: primary, delayMs: 1000 },
      { model: primary, delayMs: 2000 },
      { model: primary, delayMs: 4000 },
    ];
  }
  return [
    { model: primary, delayMs: 0 },
    { model: primary, delayMs: 1000 },
    { model: fallback, delayMs: 0, ...(crossProvider ? { provider: "fallback" as const } : {}) },
    { model: fallback, delayMs: 1000, ...(crossProvider ? { provider: "fallback" as const } : {}) },
    { model: primary, delayMs: 2000 },
  ];
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("请求已取消", "AbortError");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 按 plan 尝试到第一段正文，总预算覆盖响应头和首字等待。开始出字后按空闲时间
 * 检查断流，不再重试整条回答；用户取消时一并释放上游连接。
 */
export async function requestWithRetry(options: {
  plan: AiAttemptStep[];
  send: (model: string, signal: AbortSignal, provider?: "fallback") => Promise<Response>;
  readError: (response: Response) => Promise<string>;
  signal: AbortSignal;
  budgetMs: number;
  attemptTimeoutMs?: number;
  idleMs?: number;
  onRetry?: (attempt: AiAttempt, next: AiAttemptStep) => void;
  onStreamEnd?: (model: string, outcome: string) => void;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
}): Promise<AiUpstreamResult> {
  const { plan, send, readError, signal, budgetMs } = options;
  const wait = options.wait ?? sleep;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const start = now();
  const attempts: AiAttempt[] = [];
  const cooldowns = new Map<string, number>();
  let failure = { status: 0, detail: "" };

  for (const [index, step] of plan.entries()) {
    if (signal.aborted) throw abortError(signal);
    const target = `${step.provider ?? "primary"}:${step.model}`;
    const cooldown = Math.max(0, (cooldowns.get(target) ?? 0) - now());
    // 先试另一模型，不为了被限流或首字超时的模型耗尽整个等待预算。
    if (cooldown && plan.slice(index + 1).some(next => `${next.provider ?? "primary"}:${next.model}` !== target)) continue;
    if (index > 0) {
      const delay = Math.max(cooldown, step.delayMs * (0.8 + random() * 0.4));
      if (now() - start + delay >= budgetMs) continue;
      options.onRetry?.(attempts[attempts.length - 1], step);
      if (delay > 0) await wait(delay, signal);
    }
    if (signal.aborted) throw abortError(signal);
    const remaining = budgetMs - (now() - start);
    if (remaining <= 0) break;

    const controller = new AbortController();
    const abort = () => controller.abort(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException("等待 AI 正文超时", "TimeoutError")),
      Math.min(remaining, options.attemptTimeoutMs ?? 12000));
    let streaming = false;
    let events: AsyncGenerator<AiStreamEvent> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      controller.abort();
    };
    try {
      const response = await waitForAi(send(step.model, controller.signal, step.provider), controller.signal);
      if (now() - start >= budgetMs) throw new DOMException("等待 AI 正文超时", "TimeoutError");
      if (!response.ok || !response.body) {
        const detail = await waitForAi(readError(response), controller.signal);
        failure = { status: response.ok ? 502 : response.status, detail };
        if (response.status === 429) {
          const pause = retryAfterMs(response.headers.get("retry-after"), detail, now());
          if (pause) cooldowns.set(target, now() + pause);
        }
      } else {
        events = aiStreamEvents(response.body, controller.signal, options.idleMs);
        const prefix: AiStreamEvent[] = [];
        let size = 0;
        while (true) {
          const next = await events.next();
          if (next.done) throw { status: 502, message: "AI 没有返回正文" };
          const event = next.value;
          if (event.error) throw event.error;
          prefix.push(event);
          size += event.data.length;
          if (size > 1024 * 1024) throw { status: 502, message: "AI 只返回了过长的思考过程，没有正文" };
          if (event.content?.trim()) break;
          if (event.done || event.finishReason) {
            throw { status: event.finishReason === "content_filter" ? 422 : 502,
              message: event.finishReason === "content_filter" ? "AI 服务拦截了这次回答，请调整提问" : "AI 没有返回正文" };
          }
        }
        clearTimeout(timer);
        attempts.push({ model: step.model, status: 200, ...(step.provider ? { provider: step.provider } : {}) });
        streaming = true;
        return { ok: true, model: step.model, ...(step.provider ? { provider: step.provider } : {}), attempts,
          response: new Response(forwardAiStream(prefix, events, cleanup, outcome => options.onStreamEnd?.(step.model, outcome)),
            { headers: { "content-type": "text/event-stream" } }) };
      }
    } catch (error) {
      if (signal.aborted) throw error;
      const detail = error as { status?: number; message?: string; name?: string; detail?: string };
      failure = {
        status: detail.name === "TimeoutError" ? 408 : detail.status ?? 0,
        detail: detail.detail ?? (detail.status ? JSON.stringify({ error: { message: detail.message } }) : ""),
      };
      if (failure.status === 408) cooldowns.set(target, start + budgetMs);
      if (failure.status === 429) {
        const pause = retryAfterMs(null, failure.detail, now());
        if (pause) cooldowns.set(target, now() + pause);
      }
    } finally {
      if (!streaming) {
        cleanup();
        void events?.return(undefined).catch(() => {});
      }
    }
    attempts.push({ model: step.model, status: failure.status, ...(step.provider ? { provider: step.provider } : {}) });
    if (failure.status !== 0 && !RETRYABLE_STATUS.has(failure.status)) break;
  }
  return { ok: false, ...failure, attempts };
}

function forwardAiStream(
  prefix: AiStreamEvent[], events: AsyncGenerator<AiStreamEvent>, cleanup: () => void,
  log: (outcome: string) => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let closed = false;
  const close = (outcome: string) => {
    if (closed) return;
    closed = true;
    log(outcome);
    cleanup();
    void events.return(undefined).catch(() => {});
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = prefix.length ? { done: false, value: prefix.shift()! } : await events.next();
        if (next.done) throw new Error("回答中途断开，已保留收到的内容，可继续回答");
        const event = next.value;
        controller.enqueue(encoder.encode(`data: ${event.data.replace(/\n/g, "\ndata: ")}\n\n`));
        if (event.done || event.finishReason || event.error) {
          close(event.error ? "error" : event.finishReason ?? "done");
          controller.close();
        }
      } catch {
        if (closed) return;
        controller.enqueue(encoder.encode('data: {"error":{"message":"回答中途断开或长时间没有输出，已保留收到的内容，可继续回答"}}\n\n'));
        close("interrupted");
        controller.close();
      }
    },
    cancel() { close("canceled"); },
  });
}

/** 限流按服务端建议等待；免费日额度耗尽不在几秒内反复请求。 */
export function retryAfterMs(header: string | null, detail: string, now: number): number {
  let delay = 0;
  try {
    const parsed = JSON.parse(detail);
    const error = (Array.isArray(parsed) ? parsed[0] : parsed)?.error;
    if (/per.?day|daily|requestsperday/i.test(JSON.stringify(error))) return 86400000;
    for (const item of error?.details ?? []) {
      if (typeof item.retryDelay === "string" && /^\d+(\.\d+)?s$/.test(item.retryDelay)) {
        delay = Math.max(delay, Number(item.retryDelay.slice(0, -1)) * 1000);
      }
    }
  } catch { /* 无建议时仍按原有退避策略。 */ }
  if (header) {
    const seconds = Number(header);
    const suggested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
    if (Number.isFinite(suggested)) delay = Math.max(delay, suggested);
  }
  return delay;
}

export function aiThinkingOptions(baseUrl: string, model: string, deepThinking: boolean): Record<string, unknown> {
  if (new URL(baseUrl).hostname === "generativelanguage.googleapis.com") {
    const id = model.replace(/^models\//, "");
    if (!/^gemini-(2\.5|3(?:\.\d+)?)-/.test(id)) return {};
    if (deepThinking) {
      return { extra_body: { google: { thinking_config: {
        ...(/^gemini-2\.5-/.test(id) ? { thinking_budget: 8192 } : { thinking_level: "high" }),
        include_thoughts: true,
      } } } };
    }
    return { reasoning_effort: /^gemini-2\.5-(?!pro)/.test(id) ? "none" : "low" };
  }
  const host = new URL(baseUrl).hostname;
  if (host === "api.deepseek.com") return { thinking: { type: deepThinking ? "enabled" : "disabled" } };
  if (host === "openrouter.ai") return { reasoning: { enabled: deepThinking } };
  if (host === "api.openai.com") return deepThinking ? { reasoning_effort: "high" } : {};
  return deepThinking ? { enable_thinking: true } : {};
}

/**
 * 从上游的错误响应里取出人话。OpenAI 是 `{"error":{"message"}}`，Gemini 的兼容接口
 * 外面还包一层数组 `[{"error":{…}}]`——不解开这层，用户只看得到一个状态码。
 */
export function upstreamErrorMessage(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const record = (Array.isArray(parsed) ? parsed[0] : parsed) as
      | { error?: { message?: unknown } | string; message?: unknown }
      | undefined;
    const error = record?.error;
    const message =
      typeof error === "string" ? error : error?.message ?? record?.message;
    return typeof message === "string" ? message.trim().slice(0, 300) : "";
  } catch {
    // 不是 JSON：纯文本原样给，HTML 错误页不给（一屏标签没人看得懂）。
    return trimmed.startsWith("<") ? "" : trimmed.slice(0, 300);
  }
}

/** 最终失败时给用户看的一句话：什么原因、自动试了几次、换没换过备用模型。 */
export function aiFailureMessage(status: number, attempts: AiAttempt[], detail: string): string {
  const tries = attempts.length;
  const fallback = attempts.find((attempt) => attempt.provider || attempt.model !== attempts[0]?.model)?.model;
  const retried =
    tries > 1
      ? `，自动尝试了 ${tries} 次${fallback ? `，备用模型 ${fallback} 也没接上` : "都没成功"}`
      : "";
  if (status === 0) return `连不上这个接口地址${retried}。检查地址是否正确，或稍后再试。`;
  if (status === 429) {
    const delay = retryAfterMs(null, detail, Date.now());
    return `请求太频繁或免费额度用完了（429）${retried}。${delay >= 86400000 ? "当天额度已用完，请等待额度重置。" : delay ? `请至少等待 ${Math.ceil(delay / 1000)} 秒后再试。` : "稍后再试。"}`;
  }
  if (status === 408) return `AI 长时间没有返回正文${retried}。稍后再试。`;
  if (status === 502 && upstreamErrorMessage(detail).startsWith("AI ")) return `${upstreamErrorMessage(detail)}${retried}。稍后再试。`;
  if (RETRYABLE_STATUS.has(status)) {
    const hint = fallback || tries <= 1 ? "稍后再试。" : "稍后再试，或在设置里填一个备用模型。";
    return `AI 服务那边太忙（${status}）${retried}。${hint}`;
  }
  const upstream = upstreamErrorMessage(detail);
  const reason =
    status === 401 || status === 403
      ? `API Key 不对或没有权限（${status}）`
      : status === 404
        ? `接口地址或模型名不对（404）`
        : `AI 服务拒绝了这次请求（${status}）`;
  return upstream ? `${reason}：${upstream}` : reason;
}
