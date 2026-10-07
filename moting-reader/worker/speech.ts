/**
 * 一批朗读文本的合成：切片、并发、单片重试、拼接。网络和时钟都从参数进来，方便单测。
 * /api/tts 和 HLS 队列任务共用单片重试（synthesizeChunk）。
 */

import {
  cleanSpeechText,
  hasSpeakableText,
  joinSpeechChunks,
  splitSpeechText,
  splitStructuredSpeech,
} from "../lib/speech-batch.ts";
import type { SpeechChunkResult } from "../lib/speech-batch.ts";
import type { SpeechBoundary } from "../lib/types.ts";

/** 每片字数。合成耗时基本跟字数走（120 字 2–4 秒、360 字 9–11 秒），细切才能真并发。 */
const SHORT_CHUNK_LENGTH = 120;
const LONG_CHUNK_LENGTH = 360;
/**
 * 起播和第二段（1500 字以内）切细：用户在等着，要的是快。再长的是播放中后台预取的
 * 长批次，切粗一点——按 120 切几千字会顶到 Workers 免费版 50 个子请求的上限。
 */
const SHORT_BATCH_MAX_LENGTH = 1600;
/** 同时开几条上游连接。再多微软会按频率限流（403）。 */
const CONCURRENCY = 4;
/** 单片最多试几次。第一次失败等约 0.5 秒，第二次约 1 秒，带 ±20% 抖动。 */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export type SpeechFailureKind = "content" | "service";

/** 422：这段文本本身读不出来；503：服务暂时不可用，客户端应该稍后再试云端。 */
export class SpeechBatchError extends Error {
  readonly kind: SpeechFailureKind;

  constructor(message: string, kind: SpeechFailureKind) {
    super(message);
    this.name = "SpeechBatchError";
    this.kind = kind;
  }

  get status(): number {
    return this.kind === "content" ? 422 : 503;
  }
}

export interface SpeechBatchDeps {
  synthesize: (
    text: string,
    voice: string,
    signal: AbortSignal
  ) => Promise<SpeechChunkResult>;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 值不值得换一条连接再试：超时、断线、握手被拒都值得；音频超限这种不值得。 */
function retryable(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  return (
    error.name === "HandshakeError" ||
    error.name === "SynthesisTransportError" ||
    error.name === "TypeError"
  );
}

/** 合成一片，临时失败换条连接重试。有字可读却没回音频的，再试一次，还是没有就返回空音频。 */
export async function synthesizeChunk(
  text: string,
  voice: string,
  signal: AbortSignal,
  options: SpeechBatchDeps,
  index = 0
): Promise<SpeechChunkResult> {
  const wait = options.wait ?? sleep;
  const random = options.random ?? Math.random;
  const log = options.log ?? (() => undefined);
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await options.synthesize(text, voice, signal);
      if (!result.audio.length && attempt < 2) {
        log("tts_chunk_empty", { index, length: text.length, attempt });
        continue;
      }
      return result;
    } catch (error) {
      if (signal.aborted || isAbort(error)) throw error;
      lastError = error;
      if (!retryable(error) || attempt === MAX_ATTEMPTS) break;
      const message = error instanceof Error ? error.message : String(error);
      log("tts_chunk_retry", { index, length: text.length, attempt, error: message });
      await wait(RETRY_BASE_MS * 2 ** (attempt - 1) * (0.8 + random() * 0.4), signal);
    }
  }
  if (lastError === undefined) return { audio: new Uint8Array(0), boundaries: [] };
  throw lastError;
}

/**
 * format 2 是新客户端的结构化文本（换行表示换段、标题、换章），按结构切片、整理拼接处的停顿；
 * 老客户端每句后面一个换行，照旧切、原样拼。
 */
export async function synthesizeBatch(
  rawText: string,
  voice: string,
  signal: AbortSignal,
  options: SpeechBatchDeps & { structured?: boolean }
): Promise<{ audio: Uint8Array<ArrayBuffer>; timeline: SpeechBoundary[] }> {
  const log = options.log ?? (() => undefined);
  const text = cleanSpeechText(rawText);
  const chunkLength = text.length <= SHORT_BATCH_MAX_LENGTH ? SHORT_CHUNK_LENGTH : LONG_CHUNK_LENGTH;
  const chunks = options.structured
    ? splitStructuredSpeech(text, chunkLength)
    : splitSpeechText(text, chunkLength);
  const results = new Array<SpeechChunkResult>(chunks.length);

  // 一片彻底失败，剩下的就不用再合成了。
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });

  let cursor = 0;
  let audioBytes = 0;
  try {
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, async () => {
        while (cursor < chunks.length) {
          const index = cursor;
          cursor += 1;
          const chunk = chunks[index];
          if (!hasSpeakableText(chunk.text)) {
            results[index] = { audio: new Uint8Array(0), boundaries: [] };
            continue;
          }
          try {
            results[index] = await synthesizeChunk(chunk.text, voice, controller.signal, options, index);
          } catch (error) {
            if (!controller.signal.aborted) controller.abort(error);
            throw error;
          }
          audioBytes += results[index].audio.byteLength;
          if (audioBytes > MAX_AUDIO_BYTES) {
            throw new SpeechBatchError("朗读音频过大", "content");
          }
        }
      })
    );
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    if (error instanceof SpeechBatchError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    log("tts_batch_failed", { length: text.length, chunks: chunks.length, error: message });
    throw new SpeechBatchError(message || "朗读服务不可用", "service");
  } finally {
    signal.removeEventListener("abort", onAbort);
  }

  const joined = joinSpeechChunks(chunks, results);
  if (!joined.audio.length) {
    throw new SpeechBatchError("这一段没有可以朗读的文字", "content");
  }
  return joined;
}
