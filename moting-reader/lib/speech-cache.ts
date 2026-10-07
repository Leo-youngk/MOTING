import { fetchSpeechClip, type SpeechClip } from "./speech-audio.ts";
import type { SpeechClipPersistence } from "./speech-persist.ts";

/**
 * 内存缓存预算。跟书籍的 50MB 单文件上限是两回事，各管各的：
 * 这里存的是已经合成好的 MP3，超出后按最久未用淘汰。
 * 一格长批次约 5MB，正在播的、预取的下一格、首段和第二段同时在内存里要十几 MB，留宽一点。
 */
export const DEFAULT_CLIP_BUDGET_BYTES = 40 * 1024 * 1024;

/** 同时在飞的预取请求上限。正在播放要用的那条不受这个限制，永远插队。 */
const PREFETCH_CONCURRENCY = 2;

/**
 * 缓存键必须同时锁住文本和音色：同一音色换了位置就是另一段音频，
 * 拿旧的顶上会直接读到别的地方去。
 *
 * 倍速不进键——云端一律按原速合成，变速是播放器的 playbackRate，
 * 同一段音频所有倍速通用。将来若真把 rate/pitch 下发给合成服务，这里必须跟着加。
 */
function clipKey(text: string, voice: string): string {
  return `${voice}|${text}`;
}

function abortError(): Error {
  const error = new Error("朗读准备已取消");
  error.name = "AbortError";
  return error;
}

export function isAbortError(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "AbortError";
}

type ClipFetcher = (
  text: string,
  voice: string,
  signal: AbortSignal
) => Promise<SpeechClip>;

interface CacheEntry {
  clip: SpeechClip;
  bytes: number;
}

interface InflightEntry {
  promise: Promise<SpeechClip>;
  controller: AbortController;
  /** 还在等这次结果的消费者数。归零且不是播放请求，就没必要继续占着上游连接。 */
  waiting: number;
  /**
   * 正在播放要用：插队发出，且不被 cancelPending 波及。
   * 注意它只管「怎么排」和「会不会被批量取消」，不代表不可取消——
   * 等它的人全撤了照样掐掉，否则连点换音色时那几条没人要的合成会一直跑完。
   */
  priority: boolean;
  /** 是否已经占用了一个预取名额，决定结束时要不要还回去。 */
  counted: boolean;
}

export interface ClipStoreStats {
  hits: number;
  misses: number;
  bytes: number;
  entries: number;
}

/**
 * 合成音频的请求与缓存。做三件事：
 *
 * 1. 按（文本, 音色）缓存已经合成好的音频，命中时同步返回——同步这一点是硬要求，
 *    交接那一刻只剩「赋 src + play」两步，中间但凡有一次 await，后台的 play()
 *    就会被 iOS 当成新的自动播放请求拦掉。
 * 2. 同一段文本只发一次请求，多个消费者共用；都撤了就把请求掐掉。
 * 3. 限制预取并发，正在播放的请求不排队。
 */
export class SpeechClipStore {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, InflightEntry>();
  private readonly pending = new Map<
    string,
    { entry: InflightEntry; start: () => void }
  >();
  private running = 0;
  private bytes = 0;
  private hits = 0;
  private misses = 0;

  // 测试跑在 node --experimental-strip-types 下，构造器参数属性它不认，只能写全。
  private readonly fetcher: ClipFetcher;
  private readonly budget: number;
  private readonly concurrency: number;
  private readonly persistence: SpeechClipPersistence | null;

  constructor(
    fetcher: ClipFetcher = fetchSpeechClip,
    budget = DEFAULT_CLIP_BUDGET_BYTES,
    concurrency = PREFETCH_CONCURRENCY,
    persistence: SpeechClipPersistence | null = null
  ) {
    this.fetcher = fetcher;
    this.budget = budget;
    this.concurrency = concurrency;
    this.persistence = persistence;
  }

  /**
   * 同步命中就直接给音频，拿不到返回 null。命中会把这条挪到 LRU 队尾。
   *
   * 命中率统计只记在这里：playAt 每播一段问一次，问到就是「这次点击没等网络」。
   * request() 内部再查一次时不重复计数，否则一次未命中会被记成两次。
   */
  peek(text: string, voice: string): SpeechClip | null {
    const clip = this.lookup(clipKey(text, voice));
    if (clip) this.hits += 1;
    else this.misses += 1;
    return clip;
  }

  /** 不动 LRU 顺序、不计命中率的探测，给「这个音色准备好了没」这类判断用。 */
  has(text: string, voice: string): boolean {
    return this.cache.has(clipKey(text, voice));
  }

  request(
    text: string,
    voice: string,
    options: { priority?: boolean; signal?: AbortSignal } = {}
  ): Promise<SpeechClip> {
    const key = clipKey(text, voice);
    const cached = this.lookup(key);
    if (cached) return Promise.resolve(cached);
    if (options.signal?.aborted) return Promise.reject(abortError());

    let entry = this.inflight.get(key);
    if (!entry) {
      entry = this.startFetch(key, text, voice, options.priority ?? false);
    } else if (options.priority && !entry.priority) {
      // 本来只是顺手预取，现在真要播了，从队列里拎出来立刻发。
      entry.priority = true;
      const waiting = this.pending.get(key);
      if (waiting) {
        this.pending.delete(key);
        waiting.start();
      }
    }

    return this.attach(entry, options.signal);
  }

  /** 顺手准备，不关心结果；失败也不该冒泡成未处理拒绝。 */
  prefetch(text: string, voice: string): void {
    this.request(text, voice).catch(() => undefined);
  }

  /**
   * 只从本机缓存往内存里搬，不走网络。进播放页时先把当前位置那一格搬上来，
   * 点播放就能同步命中、立刻出声。返回这一段现在在不在内存里。
   */
  async warm(text: string, voice: string): Promise<boolean> {
    const key = clipKey(text, voice);
    if (this.cache.has(key)) return true;
    const clip = await this.persistence?.get(key).catch(() => null);
    if (!clip) return false;
    this.store(key, clip);
    return true;
  }

  /**
   * 离线缓存：合成好直接落到本机，不进内存——下载好几格的时候不能把正在播的、
   * 预取好的下一段挤出内存，那样后台换段就得现等网络。已经在本机的直接跳过。
   */
  async download(text: string, voice: string, signal?: AbortSignal): Promise<void> {
    if (!this.persistence) throw new Error("这台设备不支持离线缓存");
    const key = clipKey(text, voice);
    if (await this.persistence.has(key)) return;
    const memory = this.cache.get(key)?.clip;
    if (memory) {
      await this.persistence.put(key, memory);
      return;
    }
    const inflight = this.inflight.get(key);
    if (inflight) {
      await this.attach(inflight, signal);
      return;
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const clip = await this.fetcher(text, voice, controller.signal);
      await this.persistence.put(key, clip);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** 本机缓存里有没有这一段（离线缓存显示进度用）。 */
  async persisted(text: string, voice: string): Promise<boolean> {
    const key = clipKey(text, voice);
    if (!this.persistence) return false;
    return this.persistence.has(key).catch(() => false);
  }

  /** 换书、跳章、关面板时把还没人等的准备任务全掐掉。 */
  cancelPending(): void {
    for (const [key, waiting] of Array.from(this.pending)) {
      this.pending.delete(key);
      waiting.entry.controller.abort();
      // 门没开的话 promise 会永远卡在这儿，必须放行让它走 abort 分支。
      waiting.start();
    }
    for (const entry of this.inflight.values()) {
      if (!entry.priority) entry.controller.abort();
    }
  }

  clear(): void {
    this.cancelPending();
    this.cache.clear();
    this.bytes = 0;
  }

  stats(): ClipStoreStats {
    return {
      hits: this.hits,
      misses: this.misses,
      bytes: this.bytes,
      entries: this.cache.size,
    };
  }

  /** 查缓存并刷新 LRU 顺序，不计命中率。 */
  private lookup(key: string): SpeechClip | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    // Map 的迭代顺序就是插入顺序，删掉再塞回去等于移到队尾。
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.clip;
  }

  private attach(
    entry: InflightEntry,
    signal?: AbortSignal
  ): Promise<SpeechClip> {
    entry.waiting += 1;
    return new Promise<SpeechClip>((resolve, reject) => {
      let settled = false;
      const detach = () => {
        if (settled) return;
        settled = true;
        entry.waiting -= 1;
        // 没人等这个结果了就断掉上游：它要么是被新选择顶掉的旧音色，
        // 要么是跳位置前那一段，留着只是白占一条合成连接。
        if (entry.waiting <= 0) entry.controller.abort();
      };
      const onAbort = () => {
        detach();
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      entry.promise.then(
        (clip) => {
          signal?.removeEventListener("abort", onAbort);
          if (settled) return;
          settled = true;
          entry.waiting -= 1;
          resolve(clip);
        },
        (reason: unknown) => {
          signal?.removeEventListener("abort", onAbort);
          if (settled) return;
          settled = true;
          entry.waiting -= 1;
          reject(reason);
        }
      );
    });
  }

  private startFetch(
    key: string,
    text: string,
    voice: string,
    priority: boolean
  ): InflightEntry {
    const controller = new AbortController();
    const entry: InflightEntry = {
      promise: undefined as unknown as Promise<SpeechClip>,
      controller,
      waiting: 0,
      priority,
      counted: false,
    };

    let launch = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      launch = resolve;
    });

    entry.promise = gate
      .then(async () => {
        // 先看本机有没有：重开应用、听过的章节再听一遍，都不用再等合成。
        const saved = await this.persistence?.get(key).catch(() => null);
        if (saved) return saved;
        if (controller.signal.aborted) throw abortError();
        const clip = await this.fetcher(text, voice, controller.signal);
        void this.persistence?.put(key, clip).catch(() => undefined);
        return clip;
      })
      .then((clip) => {
        this.store(key, clip);
        return clip;
      })
      .finally(() => {
        this.inflight.delete(key);
        if (entry.counted) {
          entry.counted = false;
          this.running -= 1;
          this.pump();
        }
      });
    this.inflight.set(key, entry);

    const start = () => {
      if (!entry.priority) {
        entry.counted = true;
        this.running += 1;
      }
      launch();
    };

    if (priority) start();
    else {
      this.pending.set(key, { entry, start });
      this.pump();
    }
    return entry;
  }

  private pump(): void {
    while (this.running < this.concurrency && this.pending.size) {
      const next = this.pending.entries().next();
      if (next.done) return;
      const [key, waiting] = next.value;
      this.pending.delete(key);
      waiting.start();
    }
  }

  private store(key: string, clip: SpeechClip): void {
    const bytes = clip.audio.size;
    // 单段就吃掉整份预算的（超长章节）不进缓存，否则一进来把别人全挤走还留不住自己。
    if (bytes > this.budget) return;

    const existing = this.cache.get(key);
    if (existing) {
      this.bytes -= existing.bytes;
      this.cache.delete(key);
    }
    this.cache.set(key, { clip, bytes });
    this.bytes += bytes;

    while (this.bytes > this.budget) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      const victim = this.cache.get(oldest.value);
      this.cache.delete(oldest.value);
      if (victim) this.bytes -= victim.bytes;
    }
  }
}
