import { buildBoundaryTimeline, TICKS_PER_SECOND } from "./speech-timeline.ts";
import type { SpeechBoundary } from "./types.ts";
import type { WordBoundary } from "./speech-timeline.ts";

export interface SpeechTextChunk {
  text: string;
  start: number;
}

export interface SpeechChunkResult {
  audio: Uint8Array;
  boundaries: WordBoundary[];
}

const PRIMARY_BREAK = /[。！？!?；;\n]/;
const SECONDARY_BREAK = /[，,、：:\s]/;

/**
 * 微软的单次合成有长度上限；长批次在服务端按自然停顿切开，但保留每一字符的
 * 原始下标，后面才能把各段词级时间轴重新拼回整批文本。
 */
export function splitSpeechText(
  text: string,
  maxLength = 360
): SpeechTextChunk[] {
  if (!Number.isFinite(maxLength) || maxLength < 1) {
    throw new RangeError("maxLength 必须是正整数");
  }

  const chunks: SpeechTextChunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + Math.floor(maxLength));
    if (end < text.length) {
      const minimum = start + Math.floor(maxLength / 2);
      let naturalEnd = -1;
      for (let index = end - 1; index >= minimum; index -= 1) {
        if (PRIMARY_BREAK.test(text[index])) {
          naturalEnd = index + 1;
          break;
        }
      }
      if (naturalEnd < 0) {
        for (let index = end - 1; index >= minimum; index -= 1) {
          if (SECONDARY_BREAK.test(text[index])) {
            naturalEnd = index + 1;
            break;
          }
        }
      }
      if (naturalEnd > start) end = naturalEnd;
      // 不在 UTF-16 代理对中间硬切，避免 emoji 变成两个非法字符。
      const previous = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (
        previous >= 0xd800 &&
        previous <= 0xdbff &&
        next >= 0xdc00 &&
        next <= 0xdfff
      ) {
        end -= 1;
      }
    }

    chunks.push({ text: text.slice(start, end), start });
    start = end;
  }
  return chunks;
}

const MPEG1_LAYER3_BITRATES = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
const MPEG2_LAYER3_BITRATES = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
];
const SAMPLE_RATES = [44100, 48000, 32000];

/** 逐帧计算 MP3 时长；比拿最后一个词的结束时间更能覆盖句末静音和编码延迟。 */
export function mp3DurationSeconds(audio: Uint8Array): number {
  let offset = 0;
  let seconds = 0;

  if (
    audio.length >= 10 &&
    audio[0] === 0x49 &&
    audio[1] === 0x44 &&
    audio[2] === 0x33
  ) {
    const tagSize =
      ((audio[6] & 0x7f) << 21) |
      ((audio[7] & 0x7f) << 14) |
      ((audio[8] & 0x7f) << 7) |
      (audio[9] & 0x7f);
    offset = 10 + tagSize;
  }

  while (offset + 4 <= audio.length) {
    if (audio[offset] !== 0xff || (audio[offset + 1] & 0xe0) !== 0xe0) {
      offset += 1;
      continue;
    }

    const versionBits = (audio[offset + 1] >> 3) & 0x03;
    const layerBits = (audio[offset + 1] >> 1) & 0x03;
    const bitrateIndex = (audio[offset + 2] >> 4) & 0x0f;
    const sampleRateIndex = (audio[offset + 2] >> 2) & 0x03;
    const padding = (audio[offset + 2] >> 1) & 0x01;
    if (
      versionBits === 1 ||
      layerBits !== 1 ||
      bitrateIndex === 0 ||
      bitrateIndex === 15 ||
      sampleRateIndex === 3
    ) {
      offset += 1;
      continue;
    }

    const mpeg1 = versionBits === 3;
    const rateDivisor = versionBits === 2 ? 2 : versionBits === 0 ? 4 : 1;
    const sampleRate = SAMPLE_RATES[sampleRateIndex] / rateDivisor;
    const bitrate =
      (mpeg1
        ? MPEG1_LAYER3_BITRATES[bitrateIndex]
        : MPEG2_LAYER3_BITRATES[bitrateIndex]) * 1000;
    const frameLength = Math.floor(
      ((mpeg1 ? 144 : 72) * bitrate) / sampleRate + padding
    );
    if (frameLength < 4 || offset + frameLength > audio.length) {
      offset += 1;
      continue;
    }

    seconds += (mpeg1 ? 1152 : 576) / sampleRate;
    offset += frameLength;
  }

  return seconds;
}

function boundaryDuration(boundaries: WordBoundary[]): number {
  return boundaries.reduce(
    (duration, boundary) =>
      Math.max(duration, (boundary.offset + boundary.duration) / TICKS_PER_SECOND),
    0
  );
}

/** 把多个独立 MP3 及其词级时间轴拼成浏览器眼中的一个长媒体资源。 */
export function joinSpeechChunks(
  chunks: SpeechTextChunk[],
  results: SpeechChunkResult[]
): { audio: Uint8Array<ArrayBuffer>; timeline: SpeechBoundary[] } {
  if (chunks.length !== results.length) {
    throw new RangeError("文本分片与语音结果数量不一致");
  }

  const audio = new Uint8Array(
    new ArrayBuffer(results.reduce((total, result) => total + result.audio.length, 0))
  );
  const timeline: SpeechBoundary[] = [];
  let byteOffset = 0;
  let timeOffset = 0;

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const result = results[index];
    audio.set(result.audio, byteOffset);
    byteOffset += result.audio.length;

    for (const boundary of buildBoundaryTimeline(chunk.text, result.boundaries)) {
      timeline.push({
        time: timeOffset + boundary.time,
        charIndex: chunk.start + boundary.charIndex,
      });
    }

    timeOffset +=
      mp3DurationSeconds(result.audio) || boundaryDuration(result.boundaries);
  }

  return { audio, timeline };
}
