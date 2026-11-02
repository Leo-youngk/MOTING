import type { KnowledgeApiKey } from "../lib/knowledge-api.ts";
import { recordHash } from "../lib/sync-record.ts";

const KEY_LIMIT = 10;
const DAY_MS = 24 * 3600 * 1000;

export function knowledgeJson(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", ...Object.fromEntries(new Headers(headers)) } });
}

export class KnowledgeError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 400, code = "invalid_request") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface KeyRow {
  id: string;
  name: string;
  token_prefix: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
}

function keyInfo(row: KeyRow): KnowledgeApiKey {
  return { id: row.id, name: row.name, prefix: row.token_prefix, scope: "knowledge:read",
    createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at, lastUsedAt: row.last_used_at };
}

async function readKeyBody(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new KnowledgeError("请求内容为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); throw new KnowledgeError("请求内容过大", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch { throw new KnowledgeError("请求内容不是有效 JSON"); }
}

/** 仅由 handleSync 在验证现有会话与同源 Origin 后调用。 */
export async function handleKnowledgeKeys(request: Request, db?: D1Database): Promise<Response> {
  try {
    if (!db) throw new KnowledgeError("此部署未启用 AI 数据接口", 503, "unavailable");
    const path = new URL(request.url).pathname;
    if (path === "/api/sync/access-keys" && request.method === "GET") {
      const result = await db.prepare("SELECT id, name, token_prefix, created_at, expires_at, revoked_at, last_used_at FROM knowledge_api_keys ORDER BY created_at DESC LIMIT 100").all<KeyRow>();
      return knowledgeJson({ keys: result.results.map(keyInfo) });
    }
    if (path === "/api/sync/access-keys" && request.method === "POST") {
      const body = await readKeyBody(request);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 60) throw new KnowledgeError("密钥名称需为 1–60 个字符");
      const days = body.expiresInDays ?? 365;
      if (![30, 90, 365].includes(days as number)) throw new KnowledgeError("密钥有效期只支持 30、90 或 365 天");
      const now = Date.now();
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const token = "moting_ro_" + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const key: KeyRow = { id: crypto.randomUUID(), name, token_prefix: token.slice(0, 17), created_at: now,
        expires_at: now + Number(days) * DAY_MS, revoked_at: null, last_used_at: null };
      const result = await db.prepare(`INSERT INTO knowledge_api_keys (id, name, token_hash, token_prefix, created_at, expires_at)
        SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM knowledge_api_keys WHERE revoked_at IS NULL AND expires_at > ?) < ?`)
        .bind(key.id, name, await recordHash(token), key.token_prefix, now, key.expires_at, now, KEY_LIMIT).run();
      if (!result.meta.changes) throw new KnowledgeError("最多保留 10 个有效密钥，请先撤销不再使用的密钥", 409, "key_limit");
      return knowledgeJson({ key: keyInfo(key), token }, 201);
    }
    const revoke = /^\/api\/sync\/access-keys\/([a-f0-9-]{36})\/revoke$/.exec(path);
    if (revoke && request.method === "POST") {
      const result = await db.prepare("UPDATE knowledge_api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").bind(Date.now(), revoke[1]).run();
      if (!result.meta.changes) throw new KnowledgeError("密钥不存在", 404, "not_found");
      return knowledgeJson({ revoked: true });
    }
    throw new KnowledgeError("密钥接口不存在或请求方法不支持", 405, "method_not_allowed");
  } catch (error) { return knowledgeFailure(error); }
}

export function knowledgeFailure(error: unknown): Response {
  if (!(error instanceof KnowledgeError)) console.warn("knowledge_request_failed", { status: 503 });
  const status = error instanceof KnowledgeError ? error.status : 503;
  return knowledgeJson({ error: { code: error instanceof KnowledgeError ? error.code : "unavailable",
    message: error instanceof KnowledgeError ? error.message : "AI 数据接口暂时不可用，请稍后重试" } }, status,
  status === 401 ? { "www-authenticate": 'Bearer realm="moting-knowledge"' } : {});
}

export async function authorizeKnowledge(request: Request, db: D1Database): Promise<void> {
  const match = /^Bearer (moting_ro_[A-Za-z0-9_-]{43})$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new KnowledgeError("请提供有效的 Bearer Token", 401, "unauthorized");
  const row = await db.prepare("SELECT id, expires_at, revoked_at, last_used_at FROM knowledge_api_keys WHERE token_hash = ?")
    .bind(await recordHash(match[1])).first<Pick<KeyRow, "id" | "expires_at" | "revoked_at" | "last_used_at">>();
  const now = Date.now();
  if (!row || row.revoked_at !== null || row.expires_at <= now) throw new KnowledgeError("密钥无效、已过期或已撤销", 401, "unauthorized");
  if (row.last_used_at === null || now - row.last_used_at >= 5 * 60_000) {
    await db.prepare("UPDATE knowledge_api_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)")
      .bind(now, row.id, now - 5 * 60_000).run();
  }
}
