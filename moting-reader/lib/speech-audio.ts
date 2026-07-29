import type { SpeechBoundary } from "./types";

export interface SpeechClip {
  audio: Blob;
  timeline: SpeechBoundary[];
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
    throw new Error(detail?.error ?? `朗读服务返回 ${response.status}`);
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
