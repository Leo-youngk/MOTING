/**
 * 微软 Edge「大声朗读」语音合成。走的是非官方接口，只能在 Worker 里调用——
 * 浏览器的 WebSocket API 无法自定义 Origin，而服务端会校验它。
 */

import type { WordBoundary } from "../lib/speech-timeline";

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const SEC_MS_GEC_VERSION = "1-143.0.3650.75";
const WIN_EPOCH_SECONDS = 11644473600n;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";
const ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
const SYNTHESIS_TIMEOUT_MS = 30000;

export interface SynthesisResult {
  audio: Uint8Array;
  boundaries: WordBoundary[];
}

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
export async function synthesizeSpeech(
  text: string,
  voice: string
): Promise<SynthesisResult> {
  const connectionId = crypto.randomUUID().replace(/-/g, "");
  const url =
    "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1" +
    `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${await securityToken()}` +
    `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
    `&ConnectionId=${connectionId}`;

  const response = await fetch(url, {
    headers: {
      Upgrade: "websocket",
      Origin: ORIGIN,
      "User-Agent": USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
      Pragma: "no-cache",
      "Cache-Control": "no-cache",
    },
  });

  const socket = (response as unknown as { webSocket: WebSocket | null })
    .webSocket;
  if (!socket) {
    throw new Error(`朗读服务握手失败：HTTP ${response.status}`);
  }
  socket.accept();

  const audioFrames: (Blob | ArrayBuffer)[] = [];
  const boundaries: WordBoundary[] = [];

  const finished = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("朗读服务响应超时")),
      SYNTHESIS_TIMEOUT_MS
    );

    socket.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        audioFrames.push(event.data as Blob | ArrayBuffer);
        return;
      }

      const separator = event.data.indexOf("\r\n\r\n");
      const headers = event.data.slice(0, separator);

      if (headers.includes("Path:audio.metadata")) {
        const payload = JSON.parse(event.data.slice(separator + 4)) as {
          Metadata: {
            Type: string;
            Data: { Offset: number; Duration: number; text: { Text: string } };
          }[];
        };
        for (const item of payload.Metadata) {
          if (item.Type !== "WordBoundary") continue;
          boundaries.push({
            offset: item.Data.Offset,
            duration: item.Data.Duration,
            text: item.Data.text.Text,
          });
        }
      } else if (headers.includes("Path:turn.end")) {
        clearTimeout(timer);
        resolve();
      }
    });

    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("朗读服务连接中断"));
    });

    socket.addEventListener("close", (event: CloseEvent) => {
      clearTimeout(timer);
      if (audioFrames.length) resolve();
      else reject(new Error(`朗读服务提前关闭：${event.code}`));
    });
  });

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
  try {
    socket.close();
  } catch {
    // 服务端可能已经关闭，忽略。
  }

  // Workers 的二进制帧是 Blob，拿不到同步字节，只能收完再逐帧转换。
  // 每帧前 2 字节是大端头部长度，其后是头部文本，剩下才是音频。
  const chunks: Uint8Array[] = [];
  for (const frame of audioFrames) {
    const buffer =
      frame instanceof ArrayBuffer ? frame : await (frame as Blob).arrayBuffer();
    const view = new Uint8Array(buffer);
    chunks.push(view.subarray(2 + ((view[0] << 8) | view[1])));
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
