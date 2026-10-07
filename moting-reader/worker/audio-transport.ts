import { mp3Frames } from "../lib/speech-batch.ts";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  return crc >>> 0;
}

function table(pid: number, section: number[], counter: number): Uint8Array {
  const packet = new Uint8Array(188).fill(0xff);
  packet.set([0x47, 0x40 | (pid >> 8), pid & 255, 0x10 | (counter & 15), 0]);
  packet.set(section, 5);
  new DataView(packet.buffer).setUint32(5 + section.length, crc32(new Uint8Array(section)));
  return packet;
}

/** MPEG-TS with a PTS/PCR for every complete MPEG audio frame. No re-encoding. */
export function transportAudio(audio: Uint8Array, seconds: number, counter = 0, tableCounter = 0): { audio: Uint8Array; counter: number } {
  const packets = [
    table(0, [0, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0], tableCounter),
    table(0x1000, [2, 0xb0, 18, 0, 1, 0xc1, 0, 0, 0xe1, 0, 0xf0, 0, 4, 0xe1, 0, 0xf0, 0], tableCounter),
  ];
  let time = seconds;
  for (const frame of mp3Frames(audio)) {
    const ticks = BigInt(Math.round(time * 90000)) % (1n << 33n);
    const pts = [
      0x21 | Number((ticks >> 29n) & 14n), Number((ticks >> 22n) & 255n),
      Number((ticks >> 14n) & 254n) | 1, Number((ticks >> 7n) & 255n), Number((ticks << 1n) & 254n) | 1,
    ];
    const size = frame.length + 8;
    const pes = new Uint8Array(14 + frame.length);
    pes.set([0, 0, 1, 0xc0, size >> 8, size & 255, 0x80, 0x80, 5, ...pts]);
    pes.set(audio.subarray(frame.offset, frame.offset + frame.length), 14);
    let offset = 0;
    while (offset < pes.length) {
      const first = offset === 0;
      const length = Math.min(first ? 176 : 184, pes.length - offset);
      const packet = new Uint8Array(188).fill(0xff);
      const adaptation = 184 - length;
      packet.set([0x47, (first ? 0x40 : 0) | 1, 0, (adaptation ? 0x30 : 0x10) | (counter++ & 15)]);
      let payload = 4;
      if (adaptation) {
        packet[payload++] = adaptation - 1;
        if (adaptation > 1) packet[payload] = first ? 0x10 : 0;
        if (first) packet.set([
          Number((ticks >> 25n) & 255n), Number((ticks >> 17n) & 255n),
          Number((ticks >> 9n) & 255n), Number((ticks >> 1n) & 255n), Number((ticks & 1n) << 7n) | 0x7e, 0,
        ], payload + 1);
        payload = 4 + adaptation;
      }
      packet.set(pes.subarray(offset, offset + length), payload);
      packets.push(packet);
      offset += length;
    }
    time += frame.duration;
  }
  const result = new Uint8Array(packets.length * 188);
  packets.forEach((packet, index) => result.set(packet, index * 188));
  return { audio: result, counter: counter & 15 };
}
