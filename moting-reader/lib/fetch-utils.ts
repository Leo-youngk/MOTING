/** 正文为空的状态码：new Response 不许给它们带 body，原样交还。 */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

/**
 * 带超时的 fetch，兼容尚未实现 AbortSignal.any/timeout 的移动端浏览器。
 *
 * 响应体必须在 read 里读完：超时和外部取消要一直管到正文读完为止。以前一拿到响应头
 * 就把它们撤了，连接卡在传正文的半路（手机切网时常见）就既不超时也取消不了——
 * 同步一直挂着、占着锁，之后每一轮都被挡在外面，退出登录也打不断。
 *
 * timeoutMs 是「多久没有进展」：等响应头算一段，之后每收到一块正文重新计时。
 * 大书慢慢传不会被一刀切断，只有真卡住才会。
 */
export async function fetchWithTimeout<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  read: (response: Response) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const restartTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error("请求超时")), timeoutMs);
  };
  const parentSignal = init.signal;
  const abortFromParent = () => controller.abort(parentSignal?.reason);

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  restartTimer();
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    restartTimer();
    return await read(withProgress(response, restartTimer));
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

/** 正文每到一块就回调一次，用来给超时续命。 */
function withProgress(response: Response, onChunk: () => void): Response {
  if (!response.body || NULL_BODY_STATUS.has(response.status) || response.status < 200 || response.status > 599) {
    return response;
  }
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, stream) {
        onChunk();
        stream.enqueue(chunk);
      },
    })
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
