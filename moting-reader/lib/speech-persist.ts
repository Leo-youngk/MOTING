import { encodeSpeechClip, parseSpeechClip, type SpeechClip } from "./speech-audio.ts";

/**
 * 合成好的音频落一份到本机（Cache Storage）。重开应用接着听不用再等合成，
 * 「离线缓存」下好的章节在地铁里也能听。
 *
 * Service Worker 更新时只清 moting-shell-* 的缓存，这个名字不受影响。
 * 停顿规则变了（Worker 那边的 TTS_CACHE_VERSION）就把这里的版本也加一。
 */
const CACHE_NAME = "moting-tts-v2";
const INDEX_KEY = "moting-tts-index-v2";
/** 一格 4000 字的长批次约 5MB，200MB 大概能放四十格、十几万字。 */
export const PERSIST_BUDGET_BYTES = 200 * 1024 * 1024;

export interface SpeechClipPersistence {
  get(key: string): Promise<SpeechClip | null>;
  has(key: string): Promise<boolean>;
  put(key: string, clip: SpeechClip): Promise<void>;
}

/** 每条记录的大小和最后用到的时间，按最久未用淘汰。 */
type IndexEntries = Record<string, [bytes: number, usedAt: number]>;

function readIndex(): IndexEntries {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as IndexEntries) : {};
  } catch {
    return {};
  }
}

function writeIndex(entries: IndexEntries) {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(entries));
  } catch {
    // 存不下索引不影响播放，最多是淘汰不及时。
  }
}

async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function requestFor(hash: string): Request {
  return new Request(`/__tts-cache/${hash}`);
}

/** 浏览器不给 Cache Storage（隐私模式、非安全上下文）时返回 null，只用内存缓存。 */
export function createSpeechPersistence(
  budget = PERSIST_BUDGET_BYTES
): SpeechClipPersistence | null {
  if (typeof caches === "undefined" || typeof crypto?.subtle === "undefined") return null;
  let cachePromise: Promise<Cache> | null = null;
  const open = () => (cachePromise ??= caches.open(CACHE_NAME));

  const touch = (hash: string, bytes?: number) => {
    const entries = readIndex();
    const known = entries[hash];
    entries[hash] = [bytes ?? known?.[0] ?? 0, Date.now()];
    return entries;
  };

  return {
    async get(key) {
      try {
        const hash = await hashKey(key);
        const cache = await open();
        const response = await cache.match(requestFor(hash));
        if (!response) return null;
        const clip = parseSpeechClip(await response.arrayBuffer());
        writeIndex(touch(hash));
        return clip;
      } catch {
        return null;
      }
    },

    async has(key) {
      try {
        const cache = await open();
        return Boolean(await cache.match(requestFor(await hashKey(key))));
      } catch {
        return false;
      }
    },

    async put(key, clip) {
      try {
        const hash = await hashKey(key);
        const body = encodeSpeechClip(clip);
        const cache = await open();
        await cache.put(
          requestFor(hash),
          new Response(body, { headers: { "content-type": "application/octet-stream" } })
        );

        // 读索引、挑要淘汰的、写回索引在同一个同步片段里做完，再去删缓存：
        // 中间夹着 await 的话，同时落盘的两段会互相覆盖对方写进索引的记录。
        const entries = touch(hash, body.size);
        let total = Object.values(entries).reduce((sum, [bytes]) => sum + bytes, 0);
        const victims: string[] = [];
        const oldest = Object.entries(entries).sort((a, b) => a[1][1] - b[1][1]);
        for (const [victim, [bytes]] of oldest) {
          if (total <= budget) break;
          if (victim === hash) continue;
          delete entries[victim];
          total -= bytes;
          victims.push(victim);
        }
        writeIndex(entries);
        await Promise.all(
          victims.map((victim) => cache.delete(requestFor(victim)).catch(() => false))
        );
      } catch {
        // 本机存储满了或者不让存：不影响这一次播放。
      }
    },
  };
}
