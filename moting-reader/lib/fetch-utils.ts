/** 带超时的 fetch，兼容尚未实现 AbortSignal.any/timeout 的移动端浏览器。 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  fetcher: typeof fetch = fetch
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("请求超时")), timeoutMs);
  const parentSignal = init.signal;
  const abortFromParent = () => controller.abort(parentSignal?.reason);

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

/** 每次读到数据就重新计时；取消和断流不能让下载一直挂着。 */
export function readWithTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  signal: AbortSignal,
  timeoutMs: number
): Promise<ReadableStreamReadResult<T>> {
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown, result?: ReadableStreamReadResult<T>) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result!);
    };
    const stop = (error: unknown) => {
      finish(error);
      void reader.cancel(error).catch(() => {});
    };
    const onAbort = () => stop(signal.reason ?? new DOMException("下载已取消", "AbortError"));
    const timer = setTimeout(() => stop(new Error("下载等待超时")), timeoutMs);
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then((result) => finish(undefined, result), (error) => finish(error));
  });
}
