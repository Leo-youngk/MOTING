import assert from "node:assert/strict";
import test from "node:test";

import {
  BREAK_GAP_SECONDS,
  cleanSpeechText,
  fitChunkAudio,
  hasSpeakableText,
  joinSpeechChunks,
  mp3DurationSeconds,
  mp3Frames,
  silentMp3,
  splitStructuredSpeech as splitSpeechText,
  trailingBreak,
} from "../lib/speech-batch.ts";
import { TICKS_PER_SECOND } from "../lib/speech-timeline.ts";

const FRAME_SECONDS = 576 / 24000;

function fakeMpeg2Layer3(frameCount: number): Uint8Array {
  // MPEG-2 Layer III，48 kbps / 24 kHz：每帧 144 字节、时长 576 / 24000 秒。
  const frameLength = 144;
  const audio = new Uint8Array(frameLength * frameCount);
  for (let index = 0; index < frameCount; index += 1) {
    const offset = index * frameLength;
    audio[offset] = 0xff;
    audio[offset + 1] = 0xf3;
    audio[offset + 2] = 0x64;
    audio[offset + 3] = 0xc4;
    // 帧里随便塞点非零数据，好区分「原帧」和补出来的静音帧。
    audio[offset + 20] = 0x5a;
  }
  return audio;
}

function word(startSeconds: number, endSeconds: number, text: string) {
  return {
    offset: Math.round(startSeconds * TICKS_PER_SECOND),
    duration: Math.round((endSeconds - startSeconds) * TICKS_PER_SECOND),
    text,
  };
}

test("长文本优先在句末切分并保留原始下标", () => {
  const text = "第一句话。第二句话很长，仍然继续。第三句话。";
  const chunks = splitSpeechText(text, 12);

  assert.equal(chunks.map((chunk) => chunk.text).join(""), text);
  for (const chunk of chunks) {
    assert.equal(text.slice(chunk.start, chunk.start + chunk.text.length), chunk.text);
  }
  assert.ok(chunks.every((chunk) => chunk.text.length <= 12));
  assert.equal(chunks[chunks.length - 1].breakAfter, "sentence");
});

test("段落处优先下刀，分隔用的换行不进任何一片", () => {
  const text = "甲乙丙丁戊。己庚辛。\n壬癸子丑寅。卯辰巳午未。";
  const chunks = splitSpeechText(text, 16);

  assert.deepEqual(
    chunks.map((chunk) => [chunk.text, chunk.breakAfter]),
    [
      ["甲乙丙丁戊。己庚辛。", "paragraph"],
      ["壬癸子丑寅。卯辰巳午未。", "sentence"],
    ]
  );
  assert.equal(chunks[1].start, text.indexOf("壬"));
});

test("标题和换章一定切开，并带上对应的停顿", () => {
  const text = "上一章最后一句。\n\n\n第二章 进城\n\n那年春天。";
  const chunks = splitSpeechText(text, 360);

  assert.deepEqual(
    chunks.map((chunk) => [chunk.text, chunk.breakAfter]),
    [
      ["上一章最后一句。", "chapter"],
      ["第二章 进城", "heading"],
      ["那年春天。", "sentence"],
    ]
  );
  for (const chunk of chunks) {
    assert.equal(text.slice(chunk.start, chunk.start + chunk.text.length), chunk.text);
  }
});

test("句末的收尾引号跟着上一片走", () => {
  const text = "他说：“我不去。”她笑了笑，没有再劝他，转身走了。";
  const chunks = splitSpeechText(text, 14);
  assert.ok(chunks[0].text.endsWith("。”"), chunks[0].text);
  assert.ok(chunks[1].text.startsWith("她"));
});

test("整批末尾的换行决定这批读完之后停多久", () => {
  assert.equal(trailingBreak("一句。"), "sentence");
  assert.equal(trailingBreak("一段。\n"), "paragraph");
  assert.equal(trailingBreak("标题\n\n"), "heading");
  assert.equal(trailingBreak("章末。\n\n\n"), "chapter");
  const chunks = splitSpeechText("章末最后一句。\n\n\n", 360);
  assert.deepEqual(
    chunks.map((chunk) => [chunk.text, chunk.breakAfter]),
    [["章末最后一句。", "chapter"]]
  );
});

test("控制字符换成空格，长度不变", () => {
  const raw = "第一行\u000b第二行\u0001。\n下一段";
  const clean = cleanSpeechText(raw);
  assert.equal(clean.length, raw.length);
  assert.equal(clean, "第一行 第二行 。\n下一段");
});

test("全是符号的片不送去合成", () => {
  assert.equal(hasSpeakableText("＊　＊　＊"), false);
  assert.equal(hasSpeakableText("……——"), false);
  assert.equal(hasSpeakableText("第1章"), true);
  assert.equal(hasSpeakableText("Hello"), true);
});

test("数字静音 MP3 按帧凑够时长，能被逐帧解析", () => {
  const silence = silentMp3(0.3);
  assert.equal(mp3Frames(silence).length, Math.round(0.3 / FRAME_SECONDS));
  assert.ok(Math.abs(mp3DurationSeconds(silence) - mp3Frames(silence).length * FRAME_SECONDS) < 1e-9);
});

test("结尾静音太长时按整帧裁掉，只留到目标停顿", () => {
  const audio = fakeMpeg2Layer3(100); // 2.4 秒
  const fitted = fitChunkAudio(audio, [word(0.1, 1.0, "甲")], BREAK_GAP_SECONDS.sentence);

  // 收声在 1.0 秒，句末停顿 0.66 秒里有 0.18 秒由下一片开头的静音提供。
  const target = 1.0 + BREAK_GAP_SECONDS.sentence - 0.18;
  assert.ok(fitted.seconds >= target && fitted.seconds < target + FRAME_SECONDS + 1e-9);
  assert.equal(fitted.audio.length % 144, 0, "只能在帧边界上截");
  assert.ok(Math.abs(mp3DurationSeconds(fitted.audio) - fitted.seconds) < 1e-9);
});

test("停顿不够长时补数字静音帧", () => {
  const audio = fakeMpeg2Layer3(50); // 1.2 秒
  const fitted = fitChunkAudio(audio, [word(0.1, 1.0, "甲")], BREAK_GAP_SECONDS.chapter);

  const target = 1.0 + BREAK_GAP_SECONDS.chapter - 0.18;
  assert.ok(Math.abs(fitted.seconds - target) <= FRAME_SECONDS / 2 + 1e-9);
  const frames = mp3Frames(fitted.audio);
  assert.ok(frames.length > 50);
  assert.ok(Math.abs(mp3DurationSeconds(fitted.audio) - fitted.seconds) < 1e-9);

  const silent = fitted.audio.subarray(frames[50].offset, frames[50].offset + frames[50].length);
  assert.equal(silent.length, 144);
  assert.deepEqual(Array.from(silent.subarray(0, 4)), [0xff, 0xf3, 0x64, 0xc4]);
  assert.ok(silent.subarray(4).every((byte) => byte === 0), "边信息和数据全零才是静音");
});

test("老格式的片（没有 breakAfter）原样拼接，不整理停顿", () => {
  const audio = fakeMpeg2Layer3(100);
  const joined = joinSpeechChunks([{ text: "甲乙", start: 0 }], [{ audio, boundaries: [word(0, 0.5, "甲")] }]);
  assert.equal(joined.audio.length, audio.length);
});

test("没有词边界时不动音频", () => {
  const audio = fakeMpeg2Layer3(30);
  const fitted = fitChunkAudio(audio, [], BREAK_GAP_SECONDS.sentence);
  assert.equal(fitted.audio, audio);
  assert.ok(Math.abs(fitted.seconds - 30 * FRAME_SECONDS) < 1e-9);
});

test("拼接后的时间轴按整理过的每片时长往后推，空片跳过", () => {
  const chunks = [
    { text: "甲乙", start: 0, breakAfter: "paragraph" as const },
    { text: "＊＊", start: 3, breakAfter: "paragraph" as const },
    { text: "丙丁", start: 6, breakAfter: "sentence" as const },
  ];
  const first = fakeMpeg2Layer3(100);
  const firstWords = [word(0, 0.3, "甲"), word(0.3, 0.6, "乙")];
  const last = fakeMpeg2Layer3(40);
  const lastWords = [word(0, 0.3, "丙"), word(0.3, 0.6, "丁")];
  const joined = joinSpeechChunks(chunks, [
    { audio: first, boundaries: firstWords },
    { audio: new Uint8Array(0), boundaries: [] },
    { audio: last, boundaries: lastWords },
  ]);

  const firstSeconds = fitChunkAudio(first, firstWords, BREAK_GAP_SECONDS.paragraph).seconds;
  const lastSeconds = fitChunkAudio(last, lastWords, BREAK_GAP_SECONDS.sentence).seconds;
  assert.deepEqual(
    joined.timeline.map((entry) => entry.charIndex),
    [0, 1, 6, 7]
  );
  assert.ok(Math.abs(joined.timeline[2].time - firstSeconds) < 1e-9);
  assert.ok(Math.abs(joined.timeline[3].time - (firstSeconds + 0.3)) < 1e-9);
  assert.ok(Math.abs(mp3DurationSeconds(joined.audio) - (firstSeconds + lastSeconds)) < 1e-9);
});
