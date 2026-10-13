import { fetchWithTimeout } from "./fetch-utils.ts";

export const KNOWLEDGE_API_PATH = "/api/knowledge/v1";
export const KNOWLEDGE_KEY_PATH = "/api/sync/access-keys";

export interface KnowledgeApiKey {
  id: string;
  name: string;
  prefix: string;
  scope: "knowledge:read";
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

export async function requestKnowledgeKeys<T>(path = "", body?: object, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetchWithTimeout(`${KNOWLEDGE_KEY_PATH}${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      credentials: "same-origin",
      cache: "no-store",
      body: body ? JSON.stringify(body) : undefined,
      signal,
    }, 20_000);
  } catch {
    throw new Error("连接超时或网络不可用，请稍后重试");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (data as { error?: string | { message?: string } } | null)?.error;
    throw new Error(typeof error === "string" ? error : error?.message ?? `接口返回 ${response.status}`);
  }
  if (!data) throw new Error("接口返回了无法读取的数据");
  return data as T;
}
