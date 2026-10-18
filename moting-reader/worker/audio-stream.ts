import { splitSpeechText, mp3DurationSeconds } from "../lib/speech-batch.ts";
import { synthesizeSpeech } from "./edge-tts.ts";

const PREFIX = "audio-stream-v1/";
const VOICE = "zh-CN-YunjianNeural";
const TTL = 48 * 3600_000;
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
type Session = { text: string; seconds: number; created: number };
type Synth = typeof synthesizeSpeech;
export function streamChunks(text: string): string[] {
  const first = splitSpeechText(text, 40)[0]?.text ?? "";
  return [first, ...splitSpeechText(text.slice(first.length), 600).map(c => c.text)].filter(Boolean).slice(0, 40);
}
async function hash(text: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${VOICE}|${text}`))), b => b.toString(16).padStart(2, "0")).join("");
}
async function cacheKey(text: string) {
  return `${PREFIX}${Math.floor(Date.now() / 86400_000) * 86400_000}/clip-${await hash(text)}.mp3`;
}
function sessionKey(id: string) { return `${PREFIX}${id.split("-")[0]}/session-${id}.json`; }
function validId(id: string) { const age = Date.now() - Number(id.split("-")[0]); return /^\d{13}-[a-f0-9]{32}$/.test(id) && age >= 0 && age < TTL; }

/** One native media HTTP request drives generation; no browser TTS timers or source handoffs. */
export async function handleAudioStream(request: Request, bucket: R2Bucket, ctx?: ExecutionContext, synth: Synth = synthesizeSpeech): Promise<Response> {
  const action = new URL(request.url).pathname.replace("/api/sync/audio-stream/", "");
  if (request.method === "POST" && action === "session") {
    // Enforce an actual byte limit, not a trusted Content-Length.
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ error: "缺少正文" }, { status: 400, headers });
    let bytes = 0; const decoder = new TextDecoder(); let raw = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.length;
      if (bytes > 100_000) { await reader.cancel(); return Response.json({ error: "正文过长" }, { status: 413, headers }); }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
    let body;
    try { body = JSON.parse(raw); } catch { return Response.json({ error: "请求格式无效" }, { status: 400, headers }); }
    if (!body || typeof body.text !== "string" || !body.text.trim() || body.text.length > 22000 || !Number.isFinite(body.seconds) || body.seconds < 60 || body.seconds > 7200) return Response.json({ error: "文本或时长无效" }, { status: 400, headers });
    const id = `${Date.now()}-${crypto.randomUUID().replaceAll("-", "")}`;
    const session: Session = { text: body.text, seconds: body.seconds, created: Date.now() };
    await bucket.put(sessionKey(id), JSON.stringify(session));
    if (ctx) ctx.waitUntil((async () => {
      const first = streamChunks(session.text)[0];
      const key = await cacheKey(first);
      if (!(await bucket.head(key))) {
        const { audio } = await synth(first, VOICE, AbortSignal.timeout(25000));
        await bucket.put(key, audio);
      }
      const listed = await bucket.list({ prefix: PREFIX, limit: 50 });
      const expired = listed.objects.filter(o => Number(o.key.slice(PREFIX.length).split("/")[0]) < Date.now() - TTL).map(o => o.key);
      if (expired.length) await bucket.delete(expired);
    })().catch(() => { /* Warmup is optional; playback reports its own errors. */ }));
    return Response.json({ id, url: `/api/sync/audio-stream/${id}.mp3`, chars: session.text.length }, { headers });
  }
  const match = /^(\d{13}-[a-f0-9]{32})\.(mp3|json)$/.exec(action);
  if (!match || !validId(match[1])) return new Response("会话过期，请重新打开测试页", { status: 404, headers });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers });
  const object = await bucket.get(sessionKey(match[1]));
  if (!object) return new Response(null, { status: 404, headers });
  if (match[2] === "json") {
    const metrics = await bucket.get(`${sessionKey(match[1])}.metrics`);
    return new Response(metrics ? metrics.body : "{}", { headers: { ...headers, "content-type": "application/json" } });
  }
  const mediaHeaders = { ...headers, "content-type": "audio/mpeg", "accept-ranges": "none" };
  if (request.method === "HEAD") return new Response(null, { headers: mediaHeaders });
  // An unfinished stream has no final byte length. Ignore Range and return 200
  // per HTTP semantics; never invent Content-Length/Content-Range for Safari.
  const session = await object.json<Session>();
  const abort = new AbortController();
  const signal = AbortSignal.any([request.signal, abort.signal]);
  const chunks = streamChunks(session.text);
  const started = Date.now(); let first = true; let totalSeconds = 0; let totalBytes = 0;
  const metrics: Record<string, unknown> = { started, request: crypto.randomUUID(), chunks: 0, state: "streaming" };
  const saveMetrics = () => bucket.put(`${sessionKey(match[1])}.metrics`, JSON.stringify(metrics)).catch(() => undefined);
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (signal.aborted) throw new Error("播放连接已关闭");
        if (index >= chunks.length || totalSeconds >= session.seconds) {
          metrics.state = "complete"; metrics.duration = totalSeconds; metrics.bytes = totalBytes;
          await saveMetrics(); controller.close(); return;
        }
        const text = chunks[index];
        const key = await cacheKey(text);
        const cached = await bucket.get(key);
        let firstMetric: Promise<unknown> | undefined;
        const emit = (audio: Uint8Array) => {
          if (signal.aborted) throw new Error("播放连接已关闭");
          controller.enqueue(audio); totalBytes += audio.length;
          if (first) {
            first = false; metrics.firstAudioMs = Date.now() - started; metrics.firstSource = cached ? "cache" : "tts";
            firstMetric = saveMetrics(); firstMetric.catch(() => {});
          }
        };
        let audio: Uint8Array;
        if (cached) { audio = new Uint8Array(await cached.arrayBuffer()); emit(audio); }
        else {
          // Only retry before any bytes of this chunk were sent, avoiding repeated spoken words.
          const before = totalBytes;
          try { ({ audio } = await synth(text, VOICE, signal, emit)); }
          catch (error) {
            if (signal.aborted || totalBytes !== before) throw error;
            ({ audio } = await synth(text, VOICE, signal, emit));
          }
          await bucket.put(key, audio).catch(() => { console.warn("audio_stream_cache_write_failed"); });
        }
        await firstMetric;
        totalSeconds += mp3DurationSeconds(audio); index++;
        metrics.chunks = index; metrics.duration = totalSeconds;
      } catch (error) {
        metrics.state = signal.aborted ? "cancelled" : "error";
        metrics.error = error instanceof Error ? error.message : String(error);
        console.warn("audio_stream_failed", { ...metrics });
        abort.abort();
        try { await saveMetrics(); } catch { /* Client may have disconnected. */ }
        controller.error(error);
      }
    },
    cancel() { abort.abort(); },
  }, { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength });
  return new Response(stream, { headers: mediaHeaders });
}
