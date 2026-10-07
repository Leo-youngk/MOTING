import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLiveHls, processLiveHlsJob } from "../worker/live-hls.ts";
import { BREAK_GAP_SECONDS, mp3DurationSeconds } from "../lib/speech-batch.ts";

// 1 秒正弦波，24kHz 48kbps 单声道 MP3，格式跟云健的一样。
const audio = new Uint8Array(execFileSync("ffmpeg", [
  "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
  "-ar", "24000", "-ac", "1", "-b:a", "48k", "-f", "mp3", "pipe:1",
]));
const AUDIO_SECONDS = mp3DurationSeconds(audio);
// 假装最后一个字在 0.5 秒读完，后面全是「自带静音」。
const SPEECH_END = 0.5;
const boundaries = [{ offset: 0, duration: SPEECH_END * 10_000_000, text: "x" }];

function fixture() {
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    async put(key: string, body: string | Uint8Array) {
      objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body);
    },
    async get(key: string) {
      const bytes = objects.get(key); if (!bytes) return null;
      return { body: bytes, json: async () => JSON.parse(new TextDecoder().decode(bytes)) };
    },
    async head(key: string) {
      const bytes = objects.get(key); return bytes ? { size: bytes.length } : null;
    },
  };
  const jobs: { id: string; group: number; target: number }[] = [];
  const queue = { async send(job: (typeof jobs)[number]) { jobs.push(job); } };
  const run = (path: string, init?: RequestInit) => handleLiveHls(
    new Request(`https://test/api/sync/live/${path}`, init),
    bucket as unknown as R2Bucket, queue as unknown as Queue,
    { waitUntil() { /* 测试里不用等 */ } } as unknown as ExecutionContext
  );
  return { bucket, queue, jobs, run };
}

async function prepare(text: string, format?: number) {
  const { bucket, queue, jobs, run } = fixture();
  const session = await (await run("session", {
    method: "POST",
    body: JSON.stringify({ text, voice: "zh-CN-YunjianNeural", ...(format ? { format } : {}) }),
  })).json() as { id: string };
  const calls: string[] = [];
  const synth = async (part: string) => {
    calls.push(part);
    return { audio, boundaries };
  };
  while (jobs.length) {
    const job = jobs.shift()!;
    await processLiveHlsJob({ ...job, target: 1e9 }, bucket as unknown as R2Bucket, queue as unknown as Queue, synth);
  }
  const state = await (await run(`${session.id}/status`)).json() as {
    complete: boolean;
    segments: { start: number; end: number; duration: number }[];
  };
  const playlist = await (await run(`${session.id}/playlist.m3u8`)).text();
  return { state, playlist, calls, run, id: session.id };
}

const TEXT =
  "第一章 远行\n\n" +
  "那年冬天，雪下得特别早。母亲站在门口喊他回家吃饭。\n" +
  "他答应了一声，却没有动。\n\n\n" +
  "第二章 进城\n\n" +
  "＊　＊　＊\n\n" +
  "那年春天，雪化得特别晚。";

test("结构化会话：换章、标题、句末按设计的停顿整理每片结尾", async () => {
  const { state, calls } = await prepare(TEXT, 2);
  assert.equal(state.complete, true);
  assert.ok(!calls.some((part) => part.includes("＊")), "全是符号的片不送去合成");

  const byStart = (needle: string) => state.segments.find((part) => TEXT.slice(part.start, part.end).startsWith(needle))!;
  const expect = (gap: number) => SPEECH_END + gap - 0.18;
  const frame = 576 / 24000;
  // 标题后面：1.1 秒的停顿，比原音频长，要补静音帧。
  assert.ok(Math.abs(byStart("第一章").duration - expect(BREAK_GAP_SECONDS.heading)) <= frame);
  // 章末：1.8 秒。
  assert.ok(Math.abs(byStart("那年冬天").duration - expect(BREAK_GAP_SECONDS.chapter)) <= frame);
  // 最后一片：文本结尾没有换行，按句末停顿裁掉多余的自带静音。
  const last = byStart("那年春天");
  assert.ok(last.duration < AUDIO_SECONDS && Math.abs(last.duration - expect(BREAK_GAP_SECONDS.sentence)) <= frame);
  // 分隔用的换行不进任何一片：每片的文字都不以换行开头或结尾。
  for (const part of state.segments) {
    const text = TEXT.slice(part.start, part.end);
    assert.equal(text, text.replace(/^\n+|\n+$/g, ""));
  }
});

test("结构化会话的 MPEG-TS 能被 ffmpeg 完整解码", async () => {
  const { playlist, run, id } = await prepare(TEXT, 2);
  const directory = mkdtempSync(join(tmpdir(), "moting-live-structure-"));
  try {
    const count = (playlist.match(/#EXTINF:/g) ?? []).length;
    for (let i = 0; i < count; i++) {
      writeFileSync(join(directory, `segment-${i}.ts`), new Uint8Array(await (await run(`${id}/segment-${i}.ts`)).arrayBuffer()));
    }
    writeFileSync(join(directory, "playlist.m3u8"), playlist);
    execFileSync("ffmpeg", ["-v", "error", "-allowed_extensions", "ALL", "-i", join(directory, "playlist.m3u8"), "-f", "null", "-"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("老客户端建的会话（不带 format）照旧切片、原样拼接", async () => {
  const legacy = "第一句。\n第二句。\n".repeat(20);
  const { state, calls } = await prepare(legacy);
  assert.ok(calls.length >= 1);
  for (const part of state.segments) {
    assert.ok(Math.abs(part.duration - AUDIO_SECONDS) < 1e-9, "不裁不补");
  }
});
