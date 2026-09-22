/** Cloudflare Worker entry point. */
import handler from "vinext/server/app-router-entry";
import { DEFAULT_EDGE_VOICE } from "../lib/edge-voices";
import { joinSpeechChunks, splitSpeechText } from "../lib/speech-batch";
import { synthesizeSpeech } from "./edge-tts";
import { handleWeread } from "./weread";
import { handleZlibrary } from "./zlibrary";

const MAX_TTS_TEXT_LENGTH = 5000;
const TTS_CHUNK_LENGTH = 360;
/**
 * 点下播放键之后听到声音的时间，几乎全花在这一次合成上，而合成耗时基本跟字数走
 * （实测约「固定开销 + 18ms/字」）。首段刚好也是 360 字，按 TTS_CHUNK_LENGTH 切只有
 * 一片，下面那个并发度等于没用上。切细到 120 字让它真正并发：同样 360 字，
 * 1 片要 17.8s，3 片并发只要 3.6s。
 */
const QUICK_TTS_CHUNK_LENGTH = 120;
/**
 * 超过这个长度的就是播放中后台预取的长批次，早几秒晚几秒用户感觉不到，
 * 继续用粗分片——4800 字按 120 切要 40 个子请求，会顶到 Workers 的 subrequest 上限。
 */
const QUICK_SYNTH_MAX_LENGTH = 600;
const TTS_CONCURRENCY = 4;
const MAX_TTS_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_AI_MODELS_BODY_BYTES = 32 * 1024;
const MAX_AI_CHAT_BODY_BYTES = 512 * 1024;
const MAX_TTS_BODY_BYTES = 64 * 1024;
const MAX_AI_MODELS_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_AI_ERROR_RESPONSE_BYTES = 64 * 1024;
const AI_MODELS_TIMEOUT_MS = 30000;
const AI_CHAT_TIMEOUT_MS = 120000;
// 音色名会拼进 SSML 属性，必须限死格式，否则等于把 SSML 注入点暴露出去。
const VOICE_PATTERN = /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z]+Neural$/;

type AiRole = "system" | "user" | "assistant";

interface AiMessage {
  role: AiRole;
  content: string;
}

class PayloadError extends Error {
  constructor(
    message: string,
    readonly status: number = 400
  ) {
    super(message);
    this.name = "PayloadError";
  }
}

async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new PayloadError("请求体过大", 413);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new PayloadError("请求体为空", 400);
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new PayloadError("请求体过大", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new PayloadError("请求体不是合法 JSON", 400);
  }
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new PayloadError("上游响应过大", 502);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new PayloadError("上游响应过大", 502);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length <= maxLength ? value : null;
}

function normalizeMessages(value: unknown): AiMessage[] | null {
  if (!Array.isArray(value) || value.length > 50) return null;
  let totalLength = 0;
  const messages: AiMessage[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const role = item.role;
    const content = stringField(item.content, 20000);
    if ((role !== "system" && role !== "user" && role !== "assistant") || content === null) {
      return null;
    }
    totalLength += content.length;
    if (totalLength > 256000) return null;
    messages.push({ role, content });
  }
  return messages;
}

function aiError(message: string, status: number): Response {
  return Response.json(
    { error: { message } },
    { status, headers: { "cache-control": "no-store" } }
  );
}

/** 用户填的接口地址，转发前只做最基本的校验：必须是 https，防止拿这个转发口子当开放代理打内网/奇怪协议。 */
function normalizeAiBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 2048) return null;
  const trimmed = raw.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") return null;
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const blockedHost =
      host === "localhost" ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host === "::1" ||
      host.startsWith("127.") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
      host.startsWith("169.254.");
    if (blockedHost) return null;
    return trimmed;
  } catch {
    return null;
  }
}

/** BYOK 转发：接口地址不带 CORS 头时浏览器直连会被拦，借这层做一次服务器到服务器的转发。
 *  不落盘、不记日志，密钥只在这一次请求里过一下手。 */
async function handleAiModels(request: Request): Promise<Response> {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  let payload: Record<string, unknown>;
  try {
    const body = await readJsonBody(request, MAX_AI_MODELS_BODY_BYTES);
    if (!isRecord(body)) throw new PayloadError("请求格式不对", 400);
    payload = body;
  } catch (error) {
    return aiError(
      error instanceof PayloadError ? error.message : "请求体不是合法 JSON",
      error instanceof PayloadError ? error.status : 400
    );
  }

  const baseUrl = normalizeAiBaseUrl(payload.baseUrl);
  if (!baseUrl) return aiError("接口地址无效，必须是 https 开头", 400);
  const apiKey = stringField(payload.apiKey ?? "", 4096);
  if (apiKey === null) return aiError("API Key 过长", 400);

  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(AI_MODELS_TIMEOUT_MS)]),
    });
  } catch {
    return aiError("连不上这个接口地址，检查地址是否正确", 502);
  }

  try {
    const body = await readResponseText(upstream, MAX_AI_MODELS_RESPONSE_BYTES);
    return new Response(body, {
      status: upstream.status,
      headers: {
        "cache-control": "no-store",
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (error) {
    return aiError(
      error instanceof PayloadError ? error.message : "上游响应读取失败",
      error instanceof PayloadError ? error.status : 502
    );
  }
}

async function handleAiChat(request: Request): Promise<Response> {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  let payload: Record<string, unknown>;
  try {
    const body = await readJsonBody(request, MAX_AI_CHAT_BODY_BYTES);
    if (!isRecord(body)) throw new PayloadError("请求格式不对", 400);
    payload = body;
  } catch (error) {
    return aiError(
      error instanceof PayloadError ? error.message : "请求体不是合法 JSON",
      error instanceof PayloadError ? error.status : 400
    );
  }

  const baseUrl = normalizeAiBaseUrl(payload.baseUrl);
  if (!baseUrl) return aiError("接口地址无效，必须是 https 开头", 400);
  const model = stringField(payload.model, 200)?.trim();
  if (!model) return aiError("没有指定模型", 400);
  const messages = normalizeMessages(payload.messages);
  if (!messages) return aiError("消息格式不对或内容过长", 400);
  const apiKey = stringField(payload.apiKey ?? "", 4096);
  if (apiKey === null) return aiError("API Key 过长", 400);

  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        ...(payload.deepThinking ? { enable_thinking: true } : {}),
      }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(AI_CHAT_TIMEOUT_MS)]),
    });
  } catch {
    return aiError("连不上这个接口地址，检查地址是否正确", 502);
  }

  if (!upstream.ok || !upstream.body) {
    try {
      const detail = await readResponseText(upstream, MAX_AI_ERROR_RESPONSE_BYTES);
      return new Response(detail || JSON.stringify({ error: { message: `AI 服务返回 ${upstream.status}` } }), {
        status: upstream.status,
        headers: {
          "cache-control": "no-store",
          "content-type": upstream.headers.get("content-type") ?? "application/json",
        },
      });
    } catch (error) {
      return aiError(
        error instanceof PayloadError ? error.message : `AI 服务返回 ${upstream.status}`,
        error instanceof PayloadError ? error.status : upstream.status
      );
    }
  }

  return new Response(upstream.body, {
    headers: {
      "cache-control": "no-store",
      "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
      "x-content-type-options": "nosniff",
    },
  });
}

async function cacheKeyFor(text: string, voice: string): Promise<Request> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${voice}|${text}`)
  );
  const hash = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return new Request(`https://moting-reader.internal/tts/${hash}`);
}

/** 响应体是 [4 字节大端元数据长度][元数据 JSON][MP3]，避免 base64 多出三分之一体积。 */
function frameResponse(
  timeline: unknown,
  audio: Uint8Array
): Uint8Array<ArrayBuffer> {
  const metadata = new TextEncoder().encode(JSON.stringify(timeline));
  const body = new Uint8Array(
    new ArrayBuffer(4 + metadata.length + audio.length)
  );
  new DataView(body.buffer).setUint32(0, metadata.length);
  body.set(metadata, 4);
  body.set(audio, 4 + metadata.length);
  return body;
}

async function synthesizeLongSpeech(
  text: string,
  voice: string,
  signal: AbortSignal
) {
  const chunks = splitSpeechText(
    text,
    text.length <= QUICK_SYNTH_MAX_LENGTH
      ? QUICK_TTS_CHUNK_LENGTH
      : TTS_CHUNK_LENGTH
  );
  const results = new Array<Awaited<ReturnType<typeof synthesizeSpeech>>>(
    chunks.length
  );
  let cursor = 0;
  let audioBytes = 0;

  // 限制并发，既缩短长音频首播等待，也避免同时开太多上游 WebSocket。
  const workers = Array.from(
    { length: Math.min(TTS_CONCURRENCY, chunks.length) },
    async () => {
      while (cursor < chunks.length) {
        const index = cursor;
        cursor += 1;
        const result = await synthesizeSpeech(chunks[index].text, voice, signal);
        audioBytes += result.audio.byteLength;
        if (audioBytes > MAX_TTS_AUDIO_BYTES) {
          throw new Error("朗读音频过大");
        }
        results[index] = result;
      }
    }
  );
  await Promise.all(workers);
  return joinSpeechChunks(chunks, results);
}

async function handleSpeech(
  request: Request,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let payload: Record<string, unknown>;
  try {
    const body = await readJsonBody(request, MAX_TTS_BODY_BYTES);
    if (!isRecord(body)) throw new PayloadError("请求格式不对", 400);
    payload = body;
  } catch (error) {
    return Response.json(
      { error: error instanceof PayloadError ? error.message : "请求体不是合法 JSON" },
      { status: error instanceof PayloadError ? error.status : 400 }
    );
  }

  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) {
    return Response.json({ error: "缺少朗读文本" }, { status: 400 });
  }
  if (text.length > MAX_TTS_TEXT_LENGTH) {
    return Response.json({ error: "朗读文本过长" }, { status: 400 });
  }

  const voice =
    typeof payload.voice === "string" && VOICE_PATTERN.test(payload.voice)
      ? payload.voice
      : DEFAULT_EDGE_VOICE;

  const cache = caches.default;
  const key = await cacheKeyFor(text, voice);
  const cached = await cache.match(key);
  if (cached) return cached;

  let audio: Uint8Array;
  let timeline;
  try {
    ({ audio, timeline } = await synthesizeLongSpeech(text, voice, request.signal));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "朗读服务不可用" },
      { status: 502 }
    );
  }

  if (!audio.length) {
    return Response.json({ error: "朗读服务没有返回音频" }, { status: 502 });
  }

  const body = frameResponse(timeline, audio);
  const response = new Response(body, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
  ctx.waitUntil(
    cache.put(key, response.clone()).catch((error) => {
      console.warn("tts_cache_put_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    })
  );
  return response;
}

const worker = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith("/api/weread/")) return handleWeread(request, env, ctx);
    if (pathname.startsWith("/api/zlibrary/")) return handleZlibrary(request);
    if (pathname === "/api/tts") {
      return handleSpeech(request, ctx);
    }
    if (pathname === "/api/ai/models") {
      return handleAiModels(request);
    }
    if (pathname === "/api/ai/chat") {
      return handleAiChat(request);
    }
    return handler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

export default worker;
