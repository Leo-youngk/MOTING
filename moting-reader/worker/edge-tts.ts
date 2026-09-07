/**
 * 微软 Edge「大声朗读」语音合成。走的是非官方接口，只能在 Worker 里调用——
 * 浏览器的 WebSocket API 无法自定义 Origin，而服务端会校验它。
 */

import type { WordBoundary } from "../lib/speech-timeline";

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WIN_EPOCH_SECONDS = 11644473600n;
const ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
const SYNTHESIS_TIMEOUT_MS = 30000;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

const EDGE_UPDATES_URL = "https://edgeupdates.microsoft.com/api/products";
const EDGE_VERSION_CACHE_KEY = "https://moting-reader.internal/edge-version";
const EDGE_VERSION_TTL_SECONDS = 86400;
const EDGE_VERSION_PATTERN = /^\d+\.\d+\.\d+\.\d+$/;
/** 只在版本接口也连不上时兜底，正常路径一律用运行时解析出来的版本。 */
const FALLBACK_EDGE_VERSION = "150.0.4078.105";

export interface SynthesisResult {
  audio: Uint8Array;
  boundaries: WordBoundary[];
}

export interface EdgeProduct {
  Product: string;
  Releases: {
    Platform: string;
    Architecture: string;
    ProductVersion: string;
  }[];
}

/** 服务端按 Edge 版本校验请求，取官方更新接口里的 Windows x64 稳定版。 */
export function pickStableWindowsVersion(products: EdgeProduct[]): string | null {
  const version = products
    .find((product) => product.Product === "Stable")
    ?.Releases.find(
      (release) =>
        release.Platform === "Windows" && release.Architecture === "x64"
    )?.ProductVersion;
  return version && EDGE_VERSION_PATTERN.test(version) ? version : null;
}

async function fetchLatestEdgeVersion(signal?: AbortSignal): Promise<string | null> {
  const response = await fetch(EDGE_UPDATES_URL, {
    headers: { accept: "application/json" },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000),
  });
  if (!response.ok) return null;
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 1024 * 1024) return null;
  const body = await response.text();
  if (body.length > 1024 * 1024) return null;
  try {
    return pickStableWindowsVersion(JSON.parse(body) as EdgeProduct[]);
  } catch {
    return null;
  }
}

/**
 * 版本号缓存一天。握手被拒多半是版本过期，这时传 refresh 强制重取，
 * 让服务自己跟上微软的版本轮换，不用改代码重新发布。
 */
async function edgeVersion(refresh: boolean, signal?: AbortSignal): Promise<string> {
  const cache = caches.default;
  const key = new Request(EDGE_VERSION_CACHE_KEY);

  if (!refresh) {
    const cached = await cache.match(key);
    if (cached) {
      const cachedVersion = await cached.text();
      if (EDGE_VERSION_PATTERN.test(cachedVersion)) return cachedVersion;
    }
  }

  const version = await fetchLatestEdgeVersion(signal).catch(() => null);
  if (!version) return FALLBACK_EDGE_VERSION;

  await cache.put(
    key,
    new Response(version, {
      headers: { "cache-control": `max-age=${EDGE_VERSION_TTL_SECONDS}` },
    })
  ).catch(() => undefined);
  return version;
}

function userAgentFor(version: string): string {
  const major = version.split(".")[0];
  return (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`
  );
}

/** 只有握手阶段被拒才值得换版本重试，合成中途出错重试也没用。 */
class HandshakeError extends Error {}

/** token 按 5 分钟粒度取整，随 Edge 版本轮换，接口 403 时多半是这里过期了。 */
async function securityToken(): Promise<string> {
  let ticks = BigInt(Math.floor(Date.now() / 1000)) + WIN_EPOCH_SECONDS;
  ticks -= ticks % 300n;
  ticks *= 10000000n;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${ticks}${TRUSTED_CLIENT_TOKEN}`)
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function timestamp(): string {
  const now = new Date();
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${days[now.getUTCDay()]} ${months[now.getUTCMonth()]} ` +
    `${pad(now.getUTCDate())} ${now.getUTCFullYear()} ` +
    `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} ` +
    `GMT+0000 (Coordinated Universal Time)`
  );
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 一律按原速合成，变速交给客户端的 playbackRate：
 * 同一段文本只需合成、缓存一份，调速也能瞬时生效。
 */
async function synthesizeOnce(
  text: string,
  voice: string,
  version: string,
  signal: AbortSignal
): Promise<SynthesisResult> {
  const connectionId = crypto.randomUUID().replace(/-/g, "");
  const url =
    "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1" +
    `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${await securityToken()}` +
    `&Sec-MS-GEC-Version=1-${version}` +
    `&ConnectionId=${connectionId}`;

  const response = await fetch(url, {
    headers: {
      Upgrade: "websocket",
      Origin: ORIGIN,
      "User-Agent": userAgentFor(version),
      "Accept-Language": "en-US,en;q=0.9",
      Pragma: "no-cache",
      "Cache-Control": "no-cache",
    },
    signal,
  });

  const socket = response.webSocket;
  if (!socket) {
    throw new HandshakeError(`朗读服务握手失败：HTTP ${response.status}`);
  }
  socket.accept();

  const audioFrames: (Blob | ArrayBuffer)[] = [];
  const boundaries: WordBoundary[] = [];
  let audioBytes = 0;
  let onAbort: (() => void) | null = null;

  const finished = new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timerHandle);
      callback();
    };
    const fail = (error: Error) => settle(() => reject(error));
    const complete = () => settle(resolve);
    const timerHandle = setTimeout(
      () => fail(new Error("朗读服务响应超时")),
      SYNTHESIS_TIMEOUT_MS
    );

    socket.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        const size =
          event.data instanceof ArrayBuffer
            ? event.data.byteLength
            : event.data.size;
        audioBytes += size;
        if (audioBytes > MAX_AUDIO_BYTES) {
          fail(new Error("朗读音频过大"));
          try {
            socket.close();
          } catch {
            // 服务端可能已经关闭，忽略。
          }
          return;
        }
        audioFrames.push(event.data as Blob | ArrayBuffer);
        return;
      }

      const separator = event.data.indexOf("\r\n\r\n");
      if (separator < 0) {
        fail(new Error("朗读服务返回格式错误"));
        return;
      }
      const headers = event.data.slice(0, separator);

      if (headers.includes("Path:audio.metadata")) {
        let payload: {
          Metadata?: {
            Type: string;
            Data: { Offset: number; Duration: number; text: { Text: string } };
          }[];
        };
        try {
          payload = JSON.parse(event.data.slice(separator + 4)) as typeof payload;
        } catch {
          fail(new Error("朗读服务元数据格式错误"));
          return;
        }
        for (const item of payload.Metadata ?? []) {
          if (item.Type !== "WordBoundary") continue;
          boundaries.push({
            offset: item.Data.Offset,
            duration: item.Data.Duration,
            text: item.Data.text.Text,
          });
        }
      } else if (headers.includes("Path:turn.end")) {
        complete();
      }
    });

    socket.addEventListener("error", () => {
      fail(new Error("朗读服务连接中断"));
    });

    socket.addEventListener("close", (event: CloseEvent) => {
      if (audioFrames.length) complete();
      else fail(new Error(`朗读服务提前关闭：${event.code}`));
    });

    onAbort = () => fail(new Error("朗读请求已取消"));
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    socket.send(
      `X-Timestamp:${timestamp()}\r\n` +
        "Content-Type:application/json; charset=utf-8\r\n" +
        "Path:speech.config\r\n\r\n" +
        '{"context":{"synthesis":{"audio":{"metadataoptions":' +
        '{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},' +
        '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}'
    );

    socket.send(
      `X-RequestId:${connectionId}\r\n` +
        "Content-Type:application/ssml+xml\r\n" +
        `X-Timestamp:${timestamp()}Z\r\n` +
        "Path:ssml\r\n\r\n" +
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>" +
        `<voice name='${voice}'>` +
        "<prosody pitch='+0Hz' rate='+0%' volume='+0%'>" +
        `${escapeXml(text)}</prosody></voice></speak>`
    );
    await finished;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    try {
      socket.close();
    } catch {
      // 服务端可能已经关闭，忽略。
    }
  }

  // Workers 的二进制帧是 Blob，拿不到同步字节，只能收完再逐帧转换。
  // 每帧前 2 字节是大端头部长度，其后是头部文本，剩下才是音频。
  const chunks: Uint8Array[] = [];
  for (const frame of audioFrames) {
    const buffer =
      frame instanceof ArrayBuffer ? frame : await (frame as Blob).arrayBuffer();
    const view = new Uint8Array(buffer);
    if (view.length < 2) throw new Error("朗读服务返回了无效音频帧");
    const headerLength = (view[0] << 8) | view[1];
    if (2 + headerLength > view.length) {
      throw new Error("朗读服务返回了无效音频帧");
    }
    chunks.push(view.subarray(2 + headerLength));
  }

  const audio = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.length, 0)
  );
  let offset = 0;
  for (const chunk of chunks) {
    audio.set(chunk, offset);
    offset += chunk.length;
  }

  return { audio, boundaries };
}

/** 握手被拒时刷新版本号再试一次，让微软轮换版本后服务能自愈。 */
export async function synthesizeSpeech(
  text: string,
  voice: string,
  signal: AbortSignal
): Promise<SynthesisResult> {
  const version = await edgeVersion(false, signal);
  try {
    return await synthesizeOnce(text, voice, version, signal);
  } catch (error) {
    if (!(error instanceof HandshakeError)) throw error;
    const fresh = await edgeVersion(true, signal);
    if (fresh === version) throw error;
    return synthesizeOnce(text, voice, fresh, signal);
  }
}
