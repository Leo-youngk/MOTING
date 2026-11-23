import { execFileSync } from "node:child_process";

/** 依赖真实 MP3 的用例在没有 ffmpeg 时的 skip 理由。 */
export const MISSING_FFMPEG = "本机没有 ffmpeg：跳过需要真实 MP3 的 HLS 用例（CI 会装 ffmpeg 跑全）";

/**
 * 1 秒 440Hz 正弦波 MP3（24kHz 单声道 48kbps），格式跟云端音色一致。
 *
 * 这是传输层测试音频，不是上游 TTS 的产物：片间时间戳、字节区间、解码器能不能吃下，
 * 只有真实的 MP3 帧才测得准。造它要外部 ffmpeg——没装就返回 null，让调用方
 * 把依赖它的用例标成 skip，而不是让整份 `npm test` 跟着一台机器的缺件变红。
 */
export function fixtureAudio(): Uint8Array | null {
  try {
    return new Uint8Array(
      execFileSync(
        "ffmpeg",
        [
          "-v", "error",
          "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
          "-ar", "24000", "-ac", "1", "-b:a", "48k",
          "-f", "mp3", "pipe:1",
        ],
        { stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 }
      )
    );
  } catch {
    return null;
  }
}
