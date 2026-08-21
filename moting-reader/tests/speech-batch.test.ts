import assert from "node:assert/strict";
import test from "node:test";

import {
  joinSpeechChunks,
  mp3DurationSeconds,
  splitSpeechText,
} from "../lib/speech-batch.ts";
import { TICKS_PER_SECOND } from "../lib/speech-timeline.ts";

function fakeMpeg2Layer3(frameCount: number): Uint8Array {
  // MPEG-2 Layer III，48 kbps / 24 kHz：每帧 144 字节、时长 576 / 24000 秒。
  const frameLength = 144;
  const audio = new Uint8Array(frameLength * frameCount);
  for (let index = 0; index < frameCount; index += 1) {
    const offset = index * frameLength;
    audio[offset] = 0xff;
    audio[offset + 1] = 0xf3;
    audio[offset + 2] = 0x64;
    audio[offset + 3] = 0xc0;
  }
  return audio;
}

test("长文本优先在句末切分并保留原始下标", () => {
  const text = "第一句话。第二句话很长，仍然继续。第三句话。";
  const chunks = splitSpeechText(text, 12);

  assert.equal(chunks.map((chunk) => chunk.text).join(""), text);
  assert.deepEqual(
    chunks.map((chunk) => chunk.start),
    chunks.map((_, index) =>
      chunks.slice(0, index).reduce((total, chunk) => total + chunk.text.length, 0)
    )
  );
  assert.ok(chunks.every((chunk) => chunk.text.length <= 12));
});

test("MP3 逐帧时长用于合并跨片时间轴", () => {
  const firstAudio = fakeMpeg2Layer3(20);
  const secondAudio = fakeMpeg2Layer3(10);
  assert.ok(Math.abs(mp3DurationSeconds(firstAudio) - 0.48) < 1e-9);

  const chunks = [
    { text: "甲乙", start: 0 },
    { text: "丙丁", start: 2 },
  ];
  const joined = joinSpeechChunks(chunks, [
    {
      audio: firstAudio,
      boundaries: [
        { offset: 0, duration: 2_000_000, text: "甲" },
        { offset: 2_000_000, duration: 2_000_000, text: "乙" },
      ],
    },
    {
      audio: secondAudio,
      boundaries: [
        { offset: 0, duration: 2_000_000, text: "丙" },
        { offset: 2_000_000, duration: 2_000_000, text: "丁" },
      ],
    },
  ]);

  assert.equal(joined.audio.length, firstAudio.length + secondAudio.length);
  assert.deepEqual(
    joined.timeline.map((entry) => entry.charIndex),
    [0, 1, 2, 3]
  );
  assert.ok(Math.abs(joined.timeline[2].time - 0.48) < 1e-9);
  assert.ok(Math.abs(joined.timeline[3].time - (0.48 + 0.2)) < 1e-9);
  assert.equal(TICKS_PER_SECOND, 10_000_000);
});
