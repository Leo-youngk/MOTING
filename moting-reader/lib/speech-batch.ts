import { buildBoundaryTimeline, TICKS_PER_SECOND } from "./speech-timeline.ts";
import type { SpeechBoundary } from "./types.ts";
import type { WordBoundary } from "./speech-timeline.ts";

/**
 * 一片读完之后接多长的停顿。客户端组段时用换行把结构带给 Worker：
 * 一个换行是换段，两个是标题前后，三个以上是换章；段内切开的看切在什么标点上。
 */
export type SpeechBreak =
  | "none"
  | "clause"
  | "sentence"
  | "paragraph"
  | "heading"
  | "chapter";

export const PARAGRAPH_SEPARATOR = "\n";
export const HEADING_SEPARATOR = "\n\n";
export const CHAPTER_SEPARATOR = "\n\n\n";

/**
 * 从这片最后一个字读完，到下一片第一个字出声，中间一共静多久（1× 下的秒数）。
 *
 * 句号、逗号两档照云健自己在一次合成里的停顿：2026-10 用 ffmpeg 量过，句末约 0.66 秒、
 * 逗号约 0.3 秒。以前拼接处原样保留每片结尾约 0.88 秒的静音，再加下一片开头 0.18 秒，
 * 段落中间会随机冒出一秒多的停顿；而真正换段、换章的地方反倒没有额外停顿。
 */
export const BREAK_GAP_SECONDS: Record<SpeechBreak, number> = {
  none: 0.25,
  clause: 0.3,
  sentence: 0.66,
  paragraph: 0.8,
  heading: 1.1,
  chapter: 1.8,
};

/** 每次合成开头自带的静音。开头的帧不能裁（下一帧的比特池可能借用它），只能算进停顿里。 */
const LEADING_SILENCE_SECONDS = 0.18;
/** 最后一个词的结束时间离真正收声差几十毫秒，至少留这么多尾巴，免得吃掉字音。 */
const MIN_TAIL_SECONDS = 0.12;

export interface SpeechTextChunk {
  /** 原文切片，不含两片之间作分隔用的换行。 */
  text: string;
  /** 这一片在整批文本里从第几个字符开始。 */
  start: number;
  breakAfter: SpeechBreak;
}

export interface SpeechChunkResult {
  audio: Uint8Array;
  boundaries: WordBoundary[];
}

const PRIMARY_BREAK = /[。！？!?；;…]/;
const SECONDARY_BREAK = /[，,、：:\s]/;
/** 句末标点后面紧跟的收尾引号、括号要跟着这一句走，不能单独甩到下一片开头。 */
const CLOSING = /[”’」』》）)\]】"']/;
/** 有字可读：一片里全是标点、星号这类符号时，微软会一个字节都不回。 */
const SPEAKABLE = /[\p{L}\p{N}]/u;

export function hasSpeakableText(text: string): boolean {
  return SPEAKABLE.test(text);
}

/**
 * 微软的服务不认几个控制字符（OCR 出来的 PDF 里常见垂直制表符），带上就整片报错。
 * 换成空格，长度不变，下标不受影响。字符范围照 edge-tts 的 remove_incompatible_characters。
 */
export function cleanSpeechText(text: string): string {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, " ");
}

function breakOfRun(newlines: number): SpeechBreak {
  if (newlines >= 3) return "chapter";
  if (newlines === 2) return "heading";
  if (newlines === 1) return "paragraph";
  return "sentence";
}

/** 整批文本末尾带的分隔符：这一批读完到下一批之间该停多久。 */
export function trailingBreak(text: string): SpeechBreak {
  const match = /\n*$/.exec(text);
  return breakOfRun(match ? match[0].length : 0);
}

function isSurrogateSplit(text: string, index: number): boolean {
  const previous = text.charCodeAt(index - 1);
  const next = text.charCodeAt(index);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}

/** 在 [minimum, end) 里从后往前找切点，返回切点（不含）和这一刀的停顿类型。 */
function findCut(
  text: string,
  start: number,
  end: number,
  minimum: number
): { cut: number; next: number; breakAfter: SpeechBreak } {
  for (let index = end - 1; index >= minimum; index -= 1) {
    if (text[index] === "\n") return { cut: index, next: index + 1, breakAfter: "paragraph" };
  }
  for (let index = end - 1; index >= minimum; index -= 1) {
    if (!PRIMARY_BREAK.test(text[index])) continue;
    let cut = index + 1;
    while (cut < text.length && (PRIMARY_BREAK.test(text[cut]) || CLOSING.test(text[cut]))) {
      cut += 1;
    }
    if (cut > end) cut = index + 1;
    return { cut, next: cut, breakAfter: "sentence" };
  }
  for (let index = end - 1; index >= minimum; index -= 1) {
    if (SECONDARY_BREAK.test(text[index])) {
      return { cut: index + 1, next: index + 1, breakAfter: "clause" };
    }
  }
  let cut = end;
  if (cut > start + 1 && isSurrogateSplit(text, cut)) cut -= 1;
  return { cut, next: cut, breakAfter: "none" };
}

/**
 * 微软的单次合成有长度上限，长批次在 Worker 里按自然停顿切开，但保留每一片的原始下标，
 * 后面才能把各片的词级时间轴拼回整批文本。
 *
 * 两个以上换行（标题、换章）一定切开，因为只有在两片之间才能插静音；
 * 段内切点依次挑换行、句末标点、逗号，实在没有才按长度硬切。
 */
export function splitSpeechText(
  text: string,
  maxLength = 360
): SpeechTextChunk[] {
  if (!Number.isFinite(maxLength) || maxLength < 1) {
    throw new RangeError("maxLength 必须是正整数");
  }
  const limit = Math.floor(maxLength);
  const chunks: SpeechTextChunk[] = [];

  const pushSection = (start: number, end: number, sectionBreak: SpeechBreak) => {
    let position = start;
    while (position < end) {
      while (position < end && text[position] === "\n") position += 1;
      if (position >= end) break;

      if (end - position <= limit) {
        let cut = end;
        while (cut > position && text[cut - 1] === "\n") cut -= 1;
        chunks.push({ text: text.slice(position, cut), start: position, breakAfter: sectionBreak });
        return;
      }

      const minimum = position + Math.floor(limit / 2);
      const { cut, next, breakAfter } = findCut(text, position, position + limit, minimum);
      chunks.push({ text: text.slice(position, cut), start: position, breakAfter });
      position = next;
    }
  };

  const hard = /\n{2,}/g;
  let sectionStart = 0;
  for (let match = hard.exec(text); match; match = hard.exec(text)) {
    pushSection(sectionStart, match.index, breakOfRun(match[0].length));
    sectionStart = match.index + match[0].length;
  }
  if (sectionStart < text.length) {
    pushSection(sectionStart, text.length, trailingBreak(text));
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

export interface Mp3Frame {
  offset: number;
  length: number;
  seconds: number;
}

interface FrameFormat {
  mpeg1: boolean;
  sampleRate: number;
  bitrate: number;
  mono: boolean;
}

function frameFormat(audio: Uint8Array, offset: number): FrameFormat | null {
  if (audio[offset] !== 0xff || (audio[offset + 1] & 0xe0) !== 0xe0) return null;
  const versionBits = (audio[offset + 1] >> 3) & 0x03;
  const layerBits = (audio[offset + 1] >> 1) & 0x03;
  const bitrateIndex = (audio[offset + 2] >> 4) & 0x0f;
  const sampleRateIndex = (audio[offset + 2] >> 2) & 0x03;
  if (
    versionBits === 1 ||
    layerBits !== 1 ||
    bitrateIndex === 0 ||
    bitrateIndex === 15 ||
    sampleRateIndex === 3
  ) {
    return null;
  }
  const mpeg1 = versionBits === 3;
  const rateDivisor = versionBits === 2 ? 2 : versionBits === 0 ? 4 : 1;
  return {
    mpeg1,
    sampleRate: SAMPLE_RATES[sampleRateIndex] / rateDivisor,
    bitrate:
      (mpeg1 ? MPEG1_LAYER3_BITRATES[bitrateIndex] : MPEG2_LAYER3_BITRATES[bitrateIndex]) * 1000,
    mono: audio[offset + 3] >> 6 === 3,
  };
}

function frameBytes(format: FrameFormat, padding: number): number {
  return Math.floor(((format.mpeg1 ? 144 : 72) * format.bitrate) / format.sampleRate + padding);
}

function frameSeconds(format: FrameFormat): number {
  return (format.mpeg1 ? 1152 : 576) / format.sampleRate;
}

/** 逐帧扫一遍 MP3（跳过 ID3 和帧间杂字节），拿到每帧的位置和时长。 */
export function mp3Frames(audio: Uint8Array): Mp3Frame[] {
  const frames: Mp3Frame[] = [];
  let offset = 0;

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
    const format = frameFormat(audio, offset);
    if (!format) {
      offset += 1;
      continue;
    }
    const length = frameBytes(format, (audio[offset + 2] >> 1) & 0x01);
    if (length < 4 || offset + length > audio.length) {
      offset += 1;
      continue;
    }
    frames.push({ offset, length, seconds: frameSeconds(format) });
    offset += length;
  }
  return frames;
}

/** 逐帧计算 MP3 时长；比拿最后一个词的结束时间更能覆盖句末静音和编码延迟。 */
export function mp3DurationSeconds(audio: Uint8Array): number {
  return mp3Frames(audio).reduce((total, frame) => total + frame.seconds, 0);
}

/**
 * 照着这段音频的格式造一帧数字静音：边信息全零（part2_3_length = 0，不带任何频谱数据），
 * main_data_begin 也是 0，不借前面的比特池，插在两次合成之间不会把谁解坏。
 * LAME 编码纯静音时出的就是这种帧。
 */
function silentFrame(audio: Uint8Array, frame: Mp3Frame): { bytes: Uint8Array; seconds: number } | null {
  const format = frameFormat(audio, frame.offset);
  if (!format) return null;
  const bytes = new Uint8Array(frameBytes(format, 0));
  bytes[0] = 0xff;
  // 保留版本、层；保护位置 1，表示不带 CRC。
  bytes[1] = audio[frame.offset + 1] | 0x01;
  // 保留码率、采样率、私有位；去掉填充位，帧长就是上面算的那个数。
  bytes[2] = audio[frame.offset + 2] & ~0x02;
  bytes[3] = audio[frame.offset + 3];
  return { bytes, seconds: frameSeconds(format) };
}

function boundaryEnd(boundaries: WordBoundary[]): number {
  return boundaries.reduce(
    (end, boundary) =>
      Math.max(end, (boundary.offset + boundary.duration) / TICKS_PER_SECOND),
    0
  );
}

/**
 * 把一片合成结果的结尾整理成想要的停顿：收声之后留够 gap 减去下一片开头自带的静音，
 * 多出来的整帧裁掉，不够的补静音帧。只动结尾——MP3 的比特池只往前借，从后面截断不会
 * 把前面的帧解坏。返回整理后的音频和它的时长。
 */
export function fitChunkAudio(
  audio: Uint8Array,
  boundaries: WordBoundary[],
  gapSeconds: number
): { audio: Uint8Array; seconds: number } {
  const frames = mp3Frames(audio);
  const total = frames.reduce((sum, frame) => sum + frame.seconds, 0);
  const speechEnd = boundaryEnd(boundaries);
  if (!frames.length || speechEnd <= 0 || speechEnd > total + 0.5) {
    return { audio, seconds: total || speechEnd };
  }

  const target = speechEnd + Math.max(MIN_TAIL_SECONDS, gapSeconds - LEADING_SILENCE_SECONDS);

  if (target < total) {
    let seconds = 0;
    let end = 0;
    for (const frame of frames) {
      if (seconds >= target) break;
      seconds += frame.seconds;
      end = frame.offset + frame.length;
    }
    return { audio: audio.subarray(0, end), seconds };
  }

  const silence = silentFrame(audio, frames[frames.length - 1]);
  const missing = target - total;
  const count = silence ? Math.round(missing / silence.seconds) : 0;
  if (!silence || count <= 0) return { audio, seconds: total };

  const padded = new Uint8Array(audio.length + silence.bytes.length * count);
  padded.set(audio, 0);
  for (let index = 0; index < count; index += 1) {
    padded.set(silence.bytes, audio.length + index * silence.bytes.length);
  }
  return { audio: padded, seconds: total + silence.seconds * count };
}

/**
 * 把多个独立 MP3 及其词级时间轴拼成浏览器眼中的一个长媒体资源，
 * 并按每片之后的停顿类型整理拼接处的静音。没出声的片（全是符号）直接跳过。
 */
export function joinSpeechChunks(
  chunks: SpeechTextChunk[],
  results: SpeechChunkResult[]
): { audio: Uint8Array<ArrayBuffer>; timeline: SpeechBoundary[] } {
  if (chunks.length !== results.length) {
    throw new RangeError("文本分片与语音结果数量不一致");
  }

  const pieces: Uint8Array[] = [];
  const timeline: SpeechBoundary[] = [];
  let timeOffset = 0;

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const result = results[index];
    if (!result.audio.length) continue;

    for (const boundary of buildBoundaryTimeline(chunk.text, result.boundaries)) {
      timeline.push({
        time: timeOffset + boundary.time,
        charIndex: chunk.start + boundary.charIndex,
      });
    }

    const fitted = fitChunkAudio(
      result.audio,
      result.boundaries,
      BREAK_GAP_SECONDS[chunk.breakAfter]
    );
    pieces.push(fitted.audio);
    timeOffset += fitted.seconds;
  }

  const audio = new Uint8Array(
    new ArrayBuffer(pieces.reduce((total, piece) => total + piece.length, 0))
  );
  let byteOffset = 0;
  for (const piece of pieces) {
    audio.set(piece, byteOffset);
    byteOffset += piece.length;
  }
  return { audio, timeline };
}
