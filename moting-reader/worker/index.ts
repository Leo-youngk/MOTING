/** Cloudflare Worker entry point. */
import handler from "vinext/server/app-router-entry";
import { DEFAULT_EDGE_VOICE } from "../lib/edge-voices";
import { buildBoundaryTimeline } from "../lib/speech-timeline";
import { synthesizeSpeech } from "./edge-tts";

interface Env {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const MAX_TTS_TEXT_LENGTH = 400;
// 音色名会拼进 SSML 属性，必须限死格式，否则等于把 SSML 注入点暴露出去。
const VOICE_PATTERN = /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z]+Neural$/;

function aiError(message: string, status: number): Response {
  return Response.json({ error: { message } }, { status });
}

/** 用户填的接口地址，转发前只做最基本的校验：必须是 https，防止拿这个转发口子当开放代理打内网/奇怪协议。 */
function normalizeAiBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const trimmed = raw.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") return null;
    return trimmed;
  } catch {
    return null;
  }
}

/** BYOK 转发：接口地址不带 CORS 头时浏览器直连会被拦，借这层做一次服务器到服务器的转发。
 *  不落盘、不记日志，密钥只在这一次请求里过一下手。 */
async function handleAiModels(request: Request): Promise<Response> {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  let payload: { baseUrl?: unknown; apiKey?: unknown };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return aiError("请求体不是合法 JSON", 400);
  }

  const baseUrl = normalizeAiBaseUrl(payload.baseUrl);
  if (!baseUrl) return aiError("接口地址无效，必须是 https 开头", 400);
  const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : "";

  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    });
  } catch {
    return aiError("连不上这个接口地址，检查地址是否正确", 502);
  }

  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
}

async function handleAiChat(request: Request): Promise<Response> {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  let payload: {
    baseUrl?: unknown;
    apiKey?: unknown;
    model?: unknown;
    messages?: unknown;
    deepThinking?: unknown;
  };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return aiError("请求体不是合法 JSON", 400);
  }

  const baseUrl = normalizeAiBaseUrl(payload.baseUrl);
  if (!baseUrl) return aiError("接口地址无效，必须是 https 开头", 400);
  if (typeof payload.model !== "string" || !payload.model) return aiError("没有指定模型", 400);
  if (!Array.isArray(payload.messages)) return aiError("消息格式不对", 400);
  const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : "";

  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: payload.model,
        messages: payload.messages,
        stream: true,
        ...(payload.deepThinking ? { enable_thinking: true } : {}),
      }),
    });
  } catch {
    return aiError("连不上这个接口地址，检查地址是否正确", 502);
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text();
    return new Response(detail || JSON.stringify({ error: { message: `AI 服务返回 ${upstream.status}` } }), {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  }

  return new Response(upstream.body, {
    headers: { "content-type": upstream.headers.get("content-type") ?? "text/event-stream" },
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

async function handleSpeech(
  request: Request,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let payload: { text?: unknown; voice?: unknown };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
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
  let boundaries;
  try {
    ({ audio, boundaries } = await synthesizeSpeech(text, voice));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "朗读服务不可用" },
      { status: 502 }
    );
  }

  if (!audio.length) {
    return Response.json({ error: "朗读服务没有返回音频" }, { status: 502 });
  }

  const body = frameResponse(buildBoundaryTimeline(text, boundaries), audio);
  const response = new Response(body, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
  ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

const worker = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const pathname = new URL(request.url).pathname;
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
};

export default worker;
