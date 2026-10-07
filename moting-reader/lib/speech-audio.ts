import { fetchWithTimeout } from "./fetch-utils.ts";
import type { SpeechBoundary } from "./types";

const MAX_SPEECH_RESPONSE_BYTES = 20 * 1024 * 1024;
/** 云端大批次合成要几十秒；超过这个时间还没回来就当这次失败，交给上层重试或降级。 */
const SHORT_REQUEST_TIMEOUT_MS = 40000;
const LONG_REQUEST_TIMEOUT_MS = 150000;
const SHORT_TEXT_LENGTH = 1600;

export interface SpeechClip {
  audio: Blob;
  timeline: SpeechBoundary[];
}

/**
 * 422 说明是这一段文本本身的问题（全是符号之类），换一段还能继续走云端；
 * 网络错误、超时和 5xx 才算服务暂时不可用，那时候先退回系统朗读，过一阵再试云端。
 */
export class SpeechClipError extends Error {
  readonly serviceDown: boolean;

  constructor(message: string, serviceDown: boolean) {
    super(message);
    this.name = "SpeechClipError";
    this.serviceDown = serviceDown;
  }
}

/** 拆开 Worker 的分帧响应：[4 字节大端元数据长度][元数据 JSON][MP3]。 */
export function parseSpeechClip(buffer: ArrayBuffer): SpeechClip {
  if (buffer.byteLength > MAX_SPEECH_RESPONSE_BYTES || buffer.byteLength < 4) {
    throw new SpeechClipError("朗读服务返回了无效音频", false);
  }
  const metadataLength = new DataView(buffer).getUint32(0);
  const audioOffset = 4 + metadataLength;
  if (audioOffset > buffer.byteLength) {
    throw new SpeechClipError("朗读服务返回了无效时间轴", false);
  }
  let timeline: SpeechBoundary[];
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(new Uint8Array(buffer, 4, metadataLength))
    );
    if (!Array.isArray(parsed)) throw new Error("timeline is not an array");
    timeline = parsed as SpeechBoundary[];
  } catch {
    throw new SpeechClipError("朗读服务返回了无效时间轴", false);
  }

  return {
    audio: new Blob([new Uint8Array(buffer, audioOffset)], {
      type: "audio/mpeg",
    }),
    timeline,
  };
}

/** parseSpeechClip 的反方向，存进本地缓存用，格式跟网络上的一模一样。 */
export function encodeSpeechClip(clip: SpeechClip): Blob {
  const metadata = new TextEncoder().encode(JSON.stringify(clip.timeline));
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, metadata.length);
  return new Blob([header, metadata, clip.audio], { type: "application/octet-stream" });
}

export async function fetchSpeechClip(
  text: string,
  voice: string,
  signal?: AbortSignal
): Promise<SpeechClip> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      "/api/tts",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, voice }),
        signal,
      },
      text.length <= SHORT_TEXT_LENGTH ? SHORT_REQUEST_TIMEOUT_MS : LONG_REQUEST_TIMEOUT_MS
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    // 断网、超时：服务端那边可能好好的，但这一刻用不上。
    throw new SpeechClipError("网络不可用或朗读服务响应太慢", true);
  }

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new SpeechClipError(
      detail?.error ?? `朗读服务返回 ${response.status}`,
      response.status >= 500 || response.status === 429 || response.status === 408
    );
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_SPEECH_RESPONSE_BYTES) {
    throw new SpeechClipError("朗读音频过大", false);
  }
  let buffer: ArrayBuffer;
  try {
    buffer = await response.arrayBuffer();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new SpeechClipError("下载朗读音频时断开了", true);
  }
  return parseSpeechClip(buffer);
}
