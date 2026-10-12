import { fetchWithTimeout, readWithTimeout } from "./fetch-utils.ts";
import { mp3Frames, STRUCTURED_SPEECH_FORMAT } from "./speech-batch.ts";
import type { SpeechBoundary } from "./types";

const MAX_SPEECH_RESPONSE_BYTES = 20 * 1024 * 1024;
/** 云端大批次合成要几十秒；超过这个时间还没回来就交给上层重试同一云端音色。 */
const SHORT_REQUEST_TIMEOUT_MS = 40000;
const LONG_REQUEST_TIMEOUT_MS = 150000;
const SHORT_TEXT_LENGTH = 1600;

export interface SpeechClip {
  audio: Blob;
  timeline: SpeechBoundary[];
}

/**
 * 422 这类 4xx 说明是这一段文本本身的问题（全是符号之类），换一段还能继续走云端；
 * 断网、超时、限流和 5xx 算服务暂时不可用，自动重试同一云端音色。
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
  signal?: AbortSignal,
  options: { fetcher?: typeof fetch; timeoutMs?: number } = {}
): Promise<SpeechClip> {
  const timeoutMs = options.timeoutMs ??
    (text.length <= SHORT_TEXT_LENGTH ? SHORT_REQUEST_TIMEOUT_MS : LONG_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    // format 2：文字带段落、标题、换章的结构，Worker 按结构整理拼接处的停顿。
    response = await fetchWithTimeout(
      "/api/tts",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, voice, format: STRUCTURED_SPEECH_FORMAT }),
        signal,
      },
      timeoutMs,
      options.fetcher
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    // 断网、超时：服务端那边可能好好的，但这一刻用不上。
    throw new SpeechClipError("网络不可用或朗读服务响应太慢", true);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_SPEECH_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new SpeechClipError("朗读音频过大", false);
  }
  // fetch 的超时只管到响应头；正文也必须管取消和断流，否则会永远停在准备音频。
  const reader = response.body?.getReader();
  if (!reader) throw new SpeechClipError("朗读服务没有返回音频", true);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    const bodySignal = signal ?? new AbortController().signal;
    while (true) {
      const { done, value } = await readWithTimeout(reader, bodySignal, timeoutMs);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_SPEECH_RESPONSE_BYTES) {
        await reader.cancel();
        throw new SpeechClipError("朗读音频过大", false);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (signal?.aborted || error instanceof SpeechClipError) throw error;
    throw new SpeechClipError("下载云端音频中断或超时", true);
  } finally {
    reader.releaseLock();
  }
  const buffer = new ArrayBuffer(bytes);
  const body = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (!response.ok) {
    let detail: { error?: string } | null = null;
    try { detail = JSON.parse(new TextDecoder().decode(body)); } catch { /* 上游可能回 HTML */ }
    throw new SpeechClipError(
      typeof detail?.error === "string" ? detail.error : `朗读服务返回 ${response.status}`,
      response.status >= 500 || response.status === 429 || response.status === 408
    );
  }
  return parseSpeechClip(buffer);
}

export function parseSpeechClip(buffer: ArrayBuffer): SpeechClip {
  if (buffer.byteLength > MAX_SPEECH_RESPONSE_BYTES || buffer.byteLength < 4) {
    throw new SpeechClipError("朗读服务返回了无效音频", true);
  }
  const metadataLength = new DataView(buffer).getUint32(0);
  const audioOffset = 4 + metadataLength;
  if (audioOffset >= buffer.byteLength) {
    throw new SpeechClipError("朗读服务返回了空音频或无效时间轴", true);
  }
  let timeline: SpeechBoundary[];
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(new Uint8Array(buffer, 4, metadataLength))
    );
    if (!Array.isArray(parsed) || !parsed.every(item => item &&
      Number.isFinite(item.time) && item.time >= 0 &&
      Number.isInteger(item.charIndex) && item.charIndex >= 0)) {
      throw new Error("invalid timeline");
    }
    timeline = parsed as SpeechBoundary[];
  } catch {
    throw new SpeechClipError("朗读服务返回了无效时间轴", true);
  }
  const audio = new Uint8Array(buffer, audioOffset);
  if (!mp3Frames(audio).length) throw new SpeechClipError("朗读服务返回了不可播放的音频", true);

  return {
    audio: new Blob([audio], {
      type: "audio/mpeg",
    }),
    timeline,
  };
}
