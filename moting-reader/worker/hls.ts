import { mp3DurationSeconds, splitSpeechText } from "../lib/speech-batch.ts";

const PREFIX = "hls-probe-v1/";
const TTL = 48 * 3600_000; // Daily cache keys remain valid for at least 24 hours.
const VOICE = "zh-CN-YunjianNeural";
type Part = { offset: number; length: number; duration: number };
type Clip = { id: string; duration: number; parts: Part[] };
type Synth = (text: string, voice: string, signal: AbortSignal) => Promise<{ audio: Uint8Array }>;

/** RFC 8216 §3.4: ID3v2.4 PRIV, 33-bit timestamp on the 90 kHz clock. */
export function packedAudio(audio: Uint8Array, seconds: number): Uint8Array<ArrayBuffer> {
  const owner = new TextEncoder().encode("com.apple.streaming.transportStreamTimestamp\0");
  const payloadSize = owner.length + 8;
  const tagSize = 10 + payloadSize;
  const result = new Uint8Array(10 + tagSize + audio.length);
  result.set([73, 68, 51, 4, 0, 0, 0, 0, tagSize >> 7, tagSize & 127]);
  result.set([80, 82, 73, 86, 0, 0, payloadSize >> 7, payloadSize & 127, 0, 0], 10);
  result.set(owner, 20);
  new DataView(result.buffer).setBigUint64(20 + owner.length, BigInt(Math.round(seconds * 90000)) % (1n << 33n));
  result.set(audio, 10 + tagSize);
  return result;
}

export function vodPlaylist(clips: Clip[]): string {
  const target = Math.ceil(Math.max(...clips.flatMap(c => c.parts.map(p => p.duration))));
  const lines = ["#EXTM3U", "#EXT-X-VERSION:4", `#EXT-X-TARGETDURATION:${target}`, "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD"];
  clips.forEach((clip, index) => {
    // Independently synthesized clips restart their timestamp at zero.
    if (index) lines.push("#EXT-X-DISCONTINUITY");
    for (const p of clip.parts) lines.push(`#EXTINF:${p.duration.toFixed(6)},`, `#EXT-X-BYTERANGE:${p.length}@${p.offset}`, `audio/${clip.id}.mp3`);
  });
  return lines.concat("#EXT-X-ENDLIST", "").join("\n");
}

function validId(id: string): boolean {
  if (!/^\d{13}-[a-f0-9]{64}$/.test(id)) return false;
  const age = Date.now() - Number(id.slice(0, 13));
  return age >= 0 && age < TTL;
}
function json(body: unknown, status = 200) { return Response.json(body, { status, headers: { "cache-control": "no-store" } }); }
async function payload(request: Request): Promise<Record<string, unknown>> {
  // Count bytes while reading, including requests without Content-Length.
  const reader = request.body?.getReader();
  if (!reader) throw new Error("缺少请求体");
  const chunks: Uint8Array[] = []; let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 16384) { await reader.cancel(); throw new Error("请求体过大"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const body = JSON.parse(new TextDecoder().decode(bytes));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("请求格式不对");
  return body;
}

/** Authenticated by sync router. No book text is persisted. Playback performs R2 reads only. */
export async function handleHls(request: Request, bucket: R2Bucket, synth: Synth): Promise<Response> {
  const action = new URL(request.url).pathname.replace("/api/sync/hls/", "");
  if (request.method === "POST") {
    let body;
    try { body = await payload(request); } catch { return json({ error: "请求体无效或过大" }, 400); }
    if (action === "prepare") {
      if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 600) return json({ error: "每批需要 1–600 字" }, 400);
      const day = Math.floor(Date.now() / 86400_000) * 86400_000;
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${VOICE}|${body.text}`));
      const id = `${day}-${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")}`;
      const key = `${PREFIX}${id}.mp3`;
      const existing = await bucket.head(key);
      if (existing?.customMetadata?.clip) return json(JSON.parse(existing.customMetadata.clip));
      try {
        const chunks = splitSpeechText(body.text, 120);
        const results: Uint8Array[] = [];
        // Three sockets at most, bounded per-request generation; no waitUntil generation loop.
        for (let i = 0; i < chunks.length; i += 3) {
          results.push(...await Promise.all(chunks.slice(i, i + 3).map(async chunk => (await synth(chunk.text, VOICE, request.signal)).audio)));
        }
        const parts: Part[] = []; const packed: Uint8Array[] = []; let length = 0; let duration = 0;
        for (const audio of results) {
          const seconds = mp3DurationSeconds(audio);
          if (!(seconds > 0) || !Number.isFinite(seconds)) throw new Error("无效的 MP3 音频");
          const bytes = packedAudio(audio, duration);
          parts.push({ offset: length, length: bytes.length, duration: seconds });
          packed.push(bytes); length += bytes.length; duration += seconds;
        }
        if (length > 8 * 1024 * 1024) throw new Error("音频过大");
        const bytes = new Uint8Array(length); let offset = 0;
        for (const part of packed) { bytes.set(part, offset); offset += part.length; }
        const clip: Clip = { id, parts, duration };
        await bucket.put(key, bytes, { customMetadata: { clip: JSON.stringify(clip) }, httpMetadata: { contentType: "audio/mpeg" } });
        // Bounded opportunistic cleanup; only our own prefix, never synced books.
        const old = await bucket.list({ prefix: PREFIX, limit: 50 });
        const expired = old.objects.filter(o => Number(o.key.slice(PREFIX.length, PREFIX.length + 13)) < Date.now() - TTL).map(o => o.key);
        if (expired.length) await bucket.delete(expired);
        return json(clip);
      } catch { return json({ error: "音频准备失败，请重试；已完成的批次会复用" }, 502); }
    }
    if (action === "finish") {
      if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 40 || !body.ids.every(id => typeof id === "string" && validId(id))) return json({ error: "音频批次无效或已过期" }, 400);
      const clips: Clip[] = [];
      for (const id of body.ids) {
        const object = await bucket.head(`${PREFIX}${id}.mp3`);
        if (!object?.customMetadata?.clip) return json({ error: "音频缺失，请重新准备" }, 409);
        clips.push(JSON.parse(object.customMetadata.clip));
      }
      const id = `${Math.min(...body.ids.map(id => Number(id.slice(0, 13))))}-${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
      await bucket.put(`${PREFIX}${id}.m3u8`, vodPlaylist(clips));
      return json({ url: `/api/sync/hls/${id}.m3u8`, duration: clips.reduce((s, c) => s + c.duration, 0) });
    }
    return json({ error: "接口不存在" }, 404);
  }
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
  const match = /^(?:audio\/)?(\d{13}-[a-f0-9]{64})\.(mp3|m3u8)$/.exec(action);
  if (!match || !validId(match[1])) return new Response("已过期，请重新准备音频", { status: 404 });
  const key = `${PREFIX}${match[1]}.${match[2]}`;
  const head = await bucket.head(key);
  if (!head) return new Response(null, { status: 404 });
  const headers = new Headers({ "content-type": match[2] === "mp3" ? "audio/mpeg" : "application/vnd.apple.mpegurl", "cache-control": "private, no-store", "accept-ranges": "bytes", "x-content-type-options": "nosniff" });
  let range: { offset: number; length: number } | undefined;
  const requested = request.headers.get("range");
  if (requested) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(requested);
    const start = m ? Number(m[1]) : -1;
    const end = m?.[2] ? Math.min(Number(m[2]), head.size - 1) : head.size - 1;
    if (start < 0 || start >= head.size || end < start) return new Response(null, { status: 416, headers: { "content-range": `bytes */${head.size}` } });
    range = { offset: start, length: end - start + 1 };
    headers.set("content-range", `bytes ${start}-${end}/${head.size}`);
  }
  headers.set("content-length", String(range?.length ?? head.size));
  if (request.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });
  const object = await bucket.get(key, range ? { range } : undefined);
  if (!object) return new Response(null, { status: 404 });
  return new Response(object.body, { status: range ? 206 : 200, headers });
}
