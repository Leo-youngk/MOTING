import { buildBoundaryTimeline } from "../lib/speech-timeline.ts";
import { mp3DurationSeconds, splitMp3Audio, splitSpeechText } from "../lib/speech-batch.ts";
import { synthesizeSpeech } from "./edge-tts.ts";
import { packedAudio } from "./hls.ts";
import { transportAudio } from "./audio-transport.ts";

const PREFIX = "live-hls-v1/";
const TTL = 48 * 3600_000;
// Short jobs let a newly started session get audio before long background preparation.
const GROUP_SIZE = 2;
const LEGACY_GROUP_SIZE = 5;
const MAX_TEXT = 1_200_000;
const TARGET_DURATION = 6;
const START_BUFFER = 24;
// Only prepare the opening minute until the user actually starts listening.
// Segment GETs (issued by the native player) trigger the rolling 20-minute window.
const INITIAL_AHEAD = 90;
const REPLENISH_AT = 600;
const REPLENISH_TO = 1200;
const VOICE = /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z]+Neural$/;
const BASE_HEADERS = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };

type Segment = {
  number: number;
  start: number;
  end: number;
  duration: number;
  time: number;
  timeline: { time: number; charIndex: number }[];
};
type State = {
  id: string;
  created: number;
  group: number;
  groupSize?: number;
  duration: number;
  complete: boolean;
  updated: number;
  error?: string;
  segments: Segment[];
  // v2 has a continuous media clock and short frame-aligned media parts.
  format?: 2;
  parts?: { number: number; time: number; duration: number }[];
  target?: number;
  transport?: "mpegts";
  counter?: number;
};
type Session = { text: string; voice: string };
export type LiveHlsJob = { id: string; group: number; target: number };
type Synth = typeof synthesizeSpeech;

const root = (id: string) => `${PREFIX}${id}/`;
const eventKey = (id: string) => root(id) + `events/${Date.now()}-${crypto.randomUUID()}.json`;
const validId = (id: string) => /^\d{13}-[a-f0-9]{32}$/.test(id) && Date.now() - Number(id.slice(0, 13)) < TTL && Date.now() >= Number(id.slice(0, 13));
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: BASE_HEADERS });

async function readState(bucket: R2Bucket, id: string): Promise<State | null> {
  const item = await bucket.get(root(id) + "state.json");
  return item ? item.json<State>() : null;
}

async function record(db: D1Database | undefined, id: string, event: string, detail: unknown): Promise<void> {
  if (!db) return;
  try {
    await db.prepare("INSERT INTO audio_telemetry (session_id, at, event, detail) VALUES (?, ?, ?, ?)")
      .bind(id, Date.now(), event, JSON.stringify(detail)).run();
  } catch (error) {
    // Telemetry must never interrupt listening or stop a Queue job.
    console.warn("live_hls_telemetry_failed", { id, event, error: String(error) });
  }
}

async function pruneTelemetry(db: D1Database | undefined): Promise<void> {
  if (!db) return;
  try {
    await db.prepare("DELETE FROM audio_telemetry WHERE at < ?")
      .bind(Date.now() - 7 * 24 * 3600_000).run();
  } catch (error) {
    console.warn("live_hls_telemetry_prune_failed", { error: String(error) });
  }
}

/** The same worker is the Queue consumer; synthesis never relies on the tab staying alive. */
export async function processLiveHlsJob(
  job: LiveHlsJob,
  bucket: R2Bucket,
  queue: Queue<LiveHlsJob>,
  synth: Synth = synthesizeSpeech,
  db?: D1Database
): Promise<void> {
  if (!validId(job.id) || !Number.isInteger(job.group) || job.group < 0) return;
  const base = root(job.id);
  const [state, source] = await Promise.all([
    readState(bucket, job.id), bucket.get(base + "session.json"),
  ]);
  if (!state || !source || state.complete) return;
  const session = await source.json<Session>();
  const chunks = splitSpeechText(session.text, 120);
  // Existing queued sessions retain their original segment numbering.
  const groupSize = state.groupSize === GROUP_SIZE ? GROUP_SIZE : LEGACY_GROUP_SIZE;
  if (job.group !== state.group) {
    // Old duplicate messages must not perpetually replenish the Queue.
    if (job.group < state.group && state.duration < job.target && job.target > (state.target ?? 0)) {
      await queue.send({ id: job.id, group: state.group, target: job.target });
    }
    return;
  }
  const group = chunks.slice(job.group * groupSize, (job.group + 1) * groupSize);
  if (!group.length) return;
  try {
    const results: Awaited<ReturnType<Synth>>[] = [];
    for (let i = 0; i < group.length; i += 3) {
      results.push(...await Promise.all(group.slice(i, i + 3).map(part =>
        synth(part.text, session.voice, AbortSignal.timeout(30_000))
      )));
    }
    const segments = group.map((part, index): Segment => {
      const duration = mp3DurationSeconds(results[index].audio);
      if (!(duration > 0 && duration <= 60)) throw new Error("无效或过长的语音分片");
      return {
        number: job.group * groupSize + index,
        start: part.start,
        end: part.start + part.text.length,
        duration,
        time: 0,
        timeline: buildBoundaryTimeline(part.text, results[index].boundaries),
      };
    });
    const next = structuredClone(state);
    const media: { number: number; time: number; duration: number; audio: Uint8Array }[] = [];
    for (const [index, part] of segments.entries()) {
      part.time = next.duration;
      if (state.format === 2) {
        for (const framePart of splitMp3Audio(results[index].audio, TARGET_DURATION)) {
          const packed = state.transport === "mpegts" ? transportAudio(framePart.audio, part.time + framePart.time, next.counter ?? 0, (next.parts?.length ?? 0) + media.length) : null;
          if (packed) next.counter = packed.counter;
          media.push({ number: (next.parts?.length ?? 0) + media.length,
            time: part.time + framePart.time, duration: framePart.duration,
            audio: packed?.audio ?? packedAudio(framePart.audio, part.time + framePart.time) });
        }
      } else {
        media.push({ number: part.number, time: part.time, duration: part.duration, audio: packedAudio(results[index].audio, 0) });
      }
      next.duration += part.duration;
      next.segments.push(part);
    }
    // Publish only durable media; all parts use the same monotonically increasing 90 kHz clock.
    const extension = state.transport === "mpegts" ? "ts" : "mp3";
    await Promise.all(media.map(part => bucket.put(base + `segment-${part.number}.${extension}`, part.audio, {
      httpMetadata: { contentType: state.transport === "mpegts" ? "video/mp2t" : "audio/mpeg" },
    })));
    if (state.format === 2) (next.parts ??= []).push(...media.map(({ number, time, duration }) => ({ number, time, duration })));
    next.group++;
    next.target = Math.max(job.target, next.target ?? 0);
    next.updated = Date.now();
    delete next.error;
    next.complete = next.group * groupSize >= chunks.length;
    await bucket.put(base + "state.json", JSON.stringify(next));
    Object.assign(state, next);
    console.log("live_hls_ready", { id: job.id, group: job.group, duration: next.duration });
    await record(db, job.id, "prepared", { group: job.group, duration: next.duration, complete: next.complete });
    if (!next.complete && next.duration < next.target) {
      await queue.send({ id: job.id, group: next.group, target: next.target });
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.updated = Date.now();
    await bucket.put(base + "state.json", JSON.stringify(state));
    console.warn("live_hls_job_failed", { id: job.id, group: job.group, error: state.error });
    await record(db, job.id, "prepare-failed", { group: job.group, error: state.error });
    throw error;
  }
}

export function livePlaylist(state: State, start = 0): string {
  const lines = [
    "#EXTM3U", "#EXT-X-VERSION:4",
    `#EXT-X-TARGETDURATION:${state.format === 2 ? TARGET_DURATION : 60}`, "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:EVENT", `#EXT-X-START:TIME-OFFSET=${start.toFixed(6)},PRECISE=YES`,
  ];
  (state.parts ?? state.segments).forEach((segment, index) => {
    if (index && state.format !== 2) lines.push("#EXT-X-DISCONTINUITY");
    lines.push(`#EXTINF:${segment.duration.toFixed(6)},`, `segment-${segment.number}.${state.transport === "mpegts" ? "ts" : "mp3"}`);
  });
  if (state.complete) lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}

export async function handleLiveHls(
  request: Request,
  bucket: R2Bucket,
  queue?: Queue<LiveHlsJob>,
  ctx?: ExecutionContext,
  db?: D1Database
): Promise<Response> {
  const action = new URL(request.url).pathname.replace("/api/sync/live/", "");
  if (request.method === "POST" && action === "client") {
    let body: { id?: unknown; stage?: unknown; reason?: unknown; version?: unknown; hls?: unknown };
    try {
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > 512) return json({ error: "事件过大" }, 413);
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch { return json({ error: "事件格式无效" }, 400); }
    if (!body || typeof body.id !== "string" || !/^[a-f0-9]{32}$/.test(body.id) ||
        typeof body.stage !== "string" || !/^(prewarm|prewarm-failed|legacy-start)$/.test(body.stage) ||
        typeof body.reason !== "string" || body.reason.length > 96 ||
        typeof body.version !== "string" || !/^[\w-]{1,50}$/.test(body.version) ||
        typeof body.hls !== "boolean") return json({ error: "事件内容无效" }, 400);
    const entry = { version: body.version, reason: body.reason, hls: body.hls };
    await record(db, `client-${body.id}`, body.stage, entry);
    console.log("live_hls_client", { stage: body.stage, ...entry });
    return json({ ok: true });
  }
  if (request.method === "POST" && action === "session") {
    if (!queue) return json({ error: "音频任务服务未启用" }, 503);
    let body: { text?: unknown; voice?: unknown };
    try {
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > 4_000_000) return json({ error: "正文过长" }, 413);
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch { return json({ error: "请求内容无效" }, 400); }
    if (typeof body?.text !== "string" || !body.text.trim() || body.text.length > MAX_TEXT ||
        typeof body.voice !== "string" || !VOICE.test(body.voice)) return json({ error: "正文或音色无效" }, 400);
    const id = `${Date.now()}-${crypto.randomUUID().replaceAll("-", "")}`;
    const base = root(id);
    const state: State = { id, created: Date.now(), updated: Date.now(), group: 0, groupSize: GROUP_SIZE, duration: 0, complete: false, segments: [], format: 2, parts: [], target: INITIAL_AHEAD, transport: "mpegts", counter: 0 };
    await Promise.all([
      bucket.put(base + "session.json", JSON.stringify({ text: body.text, voice: body.voice })),
      bucket.put(base + "state.json", JSON.stringify(state)),
    ]);
    await queue.send({ id, group: 0, target: INITIAL_AHEAD });
    await record(db, id, "session", { characters: body.text.length, voice: body.voice });
    ctx?.waitUntil(pruneTelemetry(db));
    return json({ id, url: `/api/sync/live/${id}/playlist.m3u8` });
  }
  const eventMatch = /^(\d{13}-[a-f0-9]{32})\/event$/.exec(action);
  if (request.method === "POST" && eventMatch && validId(eventMatch[1])) {
    let event: { type?: unknown; ct?: unknown; rs?: unknown; visibility?: unknown; buffered?: unknown; mediaError?: unknown };
    try {
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > 1024) return json({ error: "事件过大" }, 413);
      event = JSON.parse(new TextDecoder().decode(bytes));
    } catch { return json({ error: "事件格式无效" }, 400); }
    if (!event || typeof event.type !== "string" || !/^(play|playing|pause|waiting|stalled|ended|error|visibility)$/.test(event.type) ||
        typeof event.ct !== "number" || !Number.isFinite(event.ct) ||
        typeof event.rs !== "number" || !Number.isInteger(event.rs)) return json({ error: "事件内容无效" }, 400);
    const entry = {
      type: event.type, ct: event.ct, rs: event.rs,
      buffered: Array.isArray(event.buffered) ? event.buffered.slice(0, 4).filter(range => Array.isArray(range) && range.length === 2 && range.every(value => typeof value === "number" && Number.isFinite(value))) : [],
      mediaError: typeof event.mediaError === "number" && event.mediaError >= 1 && event.mediaError <= 4 ? event.mediaError : null,
      visibility: event.visibility === "hidden" ? "hidden" : "visible", at: Date.now(),
    };
    await Promise.all([
      bucket.put(eventKey(eventMatch[1]), JSON.stringify(entry)),
      record(db, eventMatch[1], event.type, entry),
    ]);
    return json({ ok: true });
  }
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "请求方法无效" }, 405);
  const match = /^(\d{13}-[a-f0-9]{32})\/(status|diagnostics|playlist\.m3u8|segment-(\d+)\.(?:mp3|ts))$/.exec(action);
  if (!match || !validId(match[1])) return json({ error: "音频会话过期" }, 404);
  const state = await readState(bucket, match[1]);
  if (!state) return json({ error: "音频会话不存在" }, 404);
  if (match[2] === "status") return json({ ...state, ready: state.complete || state.duration >= (state.format === 2 ? START_BUFFER : 75) });
  if (match[2] === "diagnostics") {
    let cursor: string | undefined;
    let keys: string[] = [];
    do {
      const page = await bucket.list({ prefix: root(state.id) + "events/", limit: 1000, cursor });
      keys = keys.concat(page.objects.map(object => object.key)).slice(-100);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    const recent = await Promise.all(keys.map(async key => {
      const item = await bucket.get(key);
      return item ? item.json() : null;
    }));
    return json({ state, events: recent.filter(Boolean) });
  }
  if (match[2] === "playlist.m3u8") {
    const offset = Number(new URL(request.url).searchParams.get("start") ?? 0);
    const playlist = livePlaylist(state, Number.isFinite(offset) && offset >= 0 ? Math.min(offset, Math.max(0, state.duration - (state.complete ? 0 : TARGET_DURATION * 3))) : 0);
    return new Response(request.method === "HEAD" ? null : playlist, {
      headers: { ...BASE_HEADERS, "content-type": "application/vnd.apple.mpegurl" },
    });
  }
  const number = Number(match[3]);
  const segment = (state.parts ?? state.segments)[number];
  if (!segment || segment.number !== number) return json({ error: "片段尚未就绪" }, 404);
  const target = Math.max(state.duration, segment.time + REPLENISH_TO);
  if (queue && state.duration - segment.time - segment.duration < REPLENISH_AT && !state.complete && target > (state.target ?? 0)) {
    ctx?.waitUntil(queue.send({
      id: state.id, group: state.group,
      target,
    }).catch(error => console.warn("live_hls_replenish_failed", { id: state.id, error: String(error) })));
  }
  const extension = state.transport === "mpegts" ? "ts" : "mp3";
  const key = root(state.id) + `segment-${number}.${extension}`;
  const head = await bucket.head(key);
  if (!head) return json({ error: "音频片段暂时不可用" }, 503);
  const headers = new Headers({ ...BASE_HEADERS, "cache-control": "private, max-age=172800, immutable", "content-type": state.transport === "mpegts" ? "video/mp2t" : "audio/mpeg", "accept-ranges": "bytes" });
  const requested = request.headers.get("range");
  let range: { offset: number; length: number } | undefined;
  if (requested) {
    const parsed = /^bytes=(\d+)-(\d*)$/.exec(requested);
    const start = parsed ? Number(parsed[1]) : -1;
    const end = parsed?.[2] ? Math.min(Number(parsed[2]), head.size - 1) : head.size - 1;
    if (start < 0 || start >= head.size || end < start) return new Response(null, { status: 416, headers: { "content-range": `bytes */${head.size}` } });
    range = { offset: start, length: end - start + 1 };
    headers.set("content-range", `bytes ${start}-${end}/${head.size}`);
  }
  headers.set("content-length", String(range?.length ?? head.size));
  const status = range ? 206 : 200;
  if (request.method === "HEAD") return new Response(null, { status, headers });
  const object = await bucket.get(key, range ? { range } : undefined);
  if (object) {
    const entry = { type: "segment-get", segment: number, range: requested,
      availableSeconds: state.duration, at: Date.now() };
    ctx?.waitUntil(Promise.all([
      bucket.put(eventKey(state.id), JSON.stringify(entry)),
      record(db, state.id, "segment-get", entry),
    ]).catch(() => undefined));
  }
  return object ? new Response(object.body, { status, headers }) : json({ error: "音频片段暂时不可用" }, 503);
}
