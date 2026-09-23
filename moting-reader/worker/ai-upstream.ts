/**
 * AI 转发的重试与备用模型。
 *
 * 上游（比如 Gemini）忙不过来时回 503「model overloaded」，这是它那边的算力问题，
 * 官方建议客户端退避重试——官方 SDK 默认就会重试，我们直连接口得自己来。
 * 只在回答还没开始流出来之前重试：上游回了非 2xx，这次请求什么都没输出，重来不会重复。
 */

/** 值得再试的状态：限流、超时和 5xx。400/401/404 这类是配置错了，重试也没用。 */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export interface AiAttemptStep {
  model: string;
  /** 这一次开始前等多久（毫秒），实际再乘 0.8~1.2 的随机抖动。 */
  delayMs: number;
}

export interface AiAttempt {
  model: string;
  /** 上游的 HTTP 状态；0 表示连不上或超时。 */
  status: number;
}

export type AiUpstreamResult =
  | { ok: true; response: Response; model: string; attempts: AiAttempt[] }
  | { ok: false; status: number; detail: string; attempts: AiAttempt[] };

/**
 * 主模型两次（间隔约 1 秒）→ 备用模型两次（约 1 秒）→ 主模型最后一次（约 2 秒）。
 * 忙起来往往一两分钟都缓不过来，主模型连着失败就早点换备用，比守着它等更快拿到回答。
 */
export function aiAttemptPlan(primary: string, fallback: string | null): AiAttemptStep[] {
  if (!fallback || fallback === primary) {
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
    { model: fallback, delayMs: 0 },
    { model: fallback, delayMs: 1000 },
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
 * 按 plan 依次尝试，拿到第一个能流式输出的响应就返回。用户中途关掉对话框（signal
 * 中止）就不再试，把中止原样抛出去。budgetMs 是所有尝试加起来最多等多久。
 */
export async function requestWithRetry(options: {
  plan: AiAttemptStep[];
  send: (model: string) => Promise<Response>;
  readError: (response: Response) => Promise<string>;
  signal: AbortSignal;
  budgetMs: number;
  onRetry?: (attempt: AiAttempt, next: AiAttemptStep) => void;
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
  let failure = { status: 0, detail: "" };

  for (const [index, step] of plan.entries()) {
    if (index > 0) {
      const delay = step.delayMs * (0.8 + random() * 0.4);
      if (now() - start + delay > budgetMs) break;
      options.onRetry?.(attempts[attempts.length - 1], step);
      if (delay > 0) await wait(delay, signal);
    }
    if (signal.aborted) throw abortError(signal);

    let response: Response;
    try {
      response = await send(step.model);
    } catch (error) {
      if (signal.aborted) throw error;
      attempts.push({ model: step.model, status: 0 });
      failure = { status: 0, detail: "" };
      continue;
    }
    attempts.push({ model: step.model, status: response.status });
    if (response.ok && response.body) {
      return { ok: true, response, model: step.model, attempts };
    }
    failure = { status: response.status, detail: await readError(response).catch(() => "") };
    if (!RETRYABLE_STATUS.has(response.status)) break;
  }
  return { ok: false, ...failure, attempts };
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
  const fallback = attempts.find((attempt) => attempt.model !== attempts[0]?.model)?.model;
  const retried =
    tries > 1
      ? `，自动重试了 ${tries} 次${fallback ? `，备用模型 ${fallback} 也没接上` : "都没成功"}`
      : "";
  if (status === 0) return `连不上这个接口地址${retried}。检查地址是否正确，或稍后再试。`;
  if (status === 429) return `请求太频繁或免费额度用完了（429）${retried}。稍后再试。`;
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
