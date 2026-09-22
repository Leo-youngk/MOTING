import type {
  DiscoveryDetail,
  DiscoveryLanguage,
  DiscoveryPage,
  DiscoverySelection,
} from "./discovery-types";

async function responseData<T>(response: Response): Promise<T> {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error("书目服务返回了无法读取的数据，请稍后重试");
  }
  if (!response.ok) {
    const message = data && typeof data === "object" && "error" in data && typeof data.error === "string"
      ? data.error
      : "书目服务暂时不可用，请稍后重试";
    throw new Error(message);
  }
  return data as T;
}

export async function fetchDiscoveryPage(
  selection: DiscoverySelection,
  language: DiscoveryLanguage,
  page: number,
  signal: AbortSignal
): Promise<DiscoveryPage> {
  const params = new URLSearchParams({ language, page: String(page) });
  params.set(selection.kind === "topic" ? "topic" : "query", selection.value);
  const response = await discoveryRequest(`/api/discovery/search?${params}`, signal);
  return responseData<DiscoveryPage>(response);
}

export async function fetchDiscoveryDetail(workId: string, signal: AbortSignal): Promise<DiscoveryDetail> {
  const response = await discoveryRequest(`/api/discovery/work?id=${encodeURIComponent(workId)}`, signal);
  return responseData<DiscoveryDetail>(response);
}

async function discoveryRequest(url: string, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, { signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error("网络不可用，请检查连接后重试");
  }
}
