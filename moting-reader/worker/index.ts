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
    if (new URL(request.url).pathname === "/api/tts") {
      return handleSpeech(request, ctx);
    }
    return handler.fetch(request, env, ctx);
  },
};

export default worker;
