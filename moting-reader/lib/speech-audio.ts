import type { SpeechBoundary } from "./types";

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

  const buffer = await response.arrayBuffer();
  const metadataLength = new DataView(buffer).getUint32(0);
  const timeline = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 4, metadataLength))
  ) as SpeechBoundary[];

  return {
    audio: new Blob([new Uint8Array(buffer, 4 + metadataLength)], {
      type: "audio/mpeg",
    }),
    timeline,
  };
}
