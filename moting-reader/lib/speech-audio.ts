import type { SpeechBoundary } from "./types";

const MAX_SPEECH_RESPONSE_BYTES = 20 * 1024 * 1024;

export interface SpeechClip {
  audio: Blob;
  timeline: SpeechBoundary[];
}

/**
 * 4xx 说明是这一段文本本身的问题（太长、空白），换一段还能继续走云端；
 * 网络错误和 5xx 才算服务真的不可用，那时候整场收听退回系统朗读。
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
export async function fetchSpeechClip(
  text: string,
  voice: string,
  signal?: AbortSignal
): Promise<SpeechClip> {
  const response = await fetch("/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, voice }),
    signal,
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new SpeechClipError(
      detail?.error ?? `朗读服务返回 ${response.status}`,
      response.status >= 500
    );
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_SPEECH_RESPONSE_BYTES) {
    throw new SpeechClipError("朗读音频过大", false);
  }
  const buffer = await response.arrayBuffer();
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
