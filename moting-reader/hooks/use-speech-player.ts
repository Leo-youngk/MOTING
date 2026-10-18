"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flattenChapter, initialPosition, positionFor } from "../lib/content";
import { chapterLabel, displayTitle, tocIndexes, tocIndexFor, tocRange } from "../lib/display-title";
import {
  EDGE_VOICES,
  edgeVoiceName,
  isEdgeVoiceURI,
  normalizeVoiceURI,
  resolvedEdgeVoiceURI,
} from "../lib/edge-voices";
import { isAbortError, SpeechClipStore } from "../lib/speech-cache";
import {
  chapterDuration,
  listenChapter,
  sentenceAfterSeconds,
  sentenceAtSeconds,
  sentenceSeconds,
  type ListenChapter,
} from "../lib/listen-clock";
import {
  nextTier,
  segmentFromBook,
  spanForBookSentence,
  nextBookSentence,
  type BookSpeechBlock,
  type BookSpeechSpan,
  type SpeechEngine,
  type SpeechTier,
} from "../lib/speech-segments";
import { SpeechClipError, type SpeechClip } from "../lib/speech-audio";
import { STRUCTURED_SPEECH_FORMAT } from "../lib/speech-batch";
import { replacementKey, speechReplacer } from "../lib/speech-text";
import {
  liveLocationAt,
  liveTimeAtChar,
  makeLivePlan,
  type LivePlan,
  type LiveSentence,
  type LiveStatus,
} from "../lib/live-speech";
import { charIndexAt, spanAt, timeAt } from "../lib/speech-timeline";
import type {
  Book,
  BookPosition,
  PlayerVoice,
  ReaderSettings,
  SpeechLocation,
  SpeechSpan,
} from "../lib/types";

export type SleepMode = "off" | "15" | "30" | "45" | "60" | "chapter";

interface SpeechPlayerOptions {
  /**
   * 按 id 取一本已经读进内存的整本书（书目 + 正文）。书库里只有书目，正文按需读；
   * 调用方保证开播之前已经把那本书的正文读进来了。
   */
  getBook: (bookId: string) => Book | undefined;
  settings: ReaderSettings;
  onProgress: (bookId: string, position: BookPosition) => void;
}

interface SpeechPlayerState {
  voices: PlayerVoice[];
  isPlaying: boolean;
  isPaused: boolean;
  isBuffering: boolean;
  location: SpeechLocation | null;
  currentSentenceId: string;
  error: string;
  sleepMode: SleepMode;
  /** 定时关闭到点的时刻（毫秒时间戳），播放页拿它倒计时；「本章结束后」和关闭时是 null。 */
  sleepDeadline: number | null;
  /** 真正在出声的云端音色，已折算成具体音色。 */
  activeVoiceURI: string;
  /** 用户刚点、正在准备的音色。空串表示没有正在进行的切换。 */
  pendingVoiceURI: string;
  /** 切换失败的原因。原音色会继续播，用户可以重试。 */
  voiceError: string;
  /** 在点击事件里先激活媒体元素，再异步读取正文。 */
  preparePlayback: () => void;
  start: (bookId: string, position?: BookPosition) => void;
  toggle: () => void;
  stop: () => void;
  skipSentences: (delta: number) => void;
  /** 前进、后退多少秒（屏幕上的时间，已经除过倍速），落在那一刻正在读的那一句。 */
  skipSeconds: (seconds: number) => void;
  changeChapter: (delta: number) => void;
  setSleepMode: (mode: SleepMode) => void;
  retryVoiceSwitch: () => void;
  /** 打开音色面板时顺手准备几个候选，让常用音色的切换命中缓存。 */
  prefetchVoices: (voiceURIs: string[]) => void;
  /** 关面板、跳章、换书时把还没人要的准备任务掐掉。 */
  cancelVoicePrefetch: () => void;
  /** 进播放页时把首段提前备好，点下去就不用等合成。 */
  prefetchStart: (book: Book, position: BookPosition) => void;
  /** 这一场用过的音色，最近的排前面。面板拿它决定预取谁。 */
  recentVoiceURIs: string[];
}

const HIGHLIGHT_INTERVAL_MS = 100;
/** 云端失败后先等这么久再试一次，大多是一时的网络抖动。 */
const EDGE_RETRY_DELAY_MS = 1500;
/** 「本章结束后」停在换章前的静音里：拼接时章与章之间留了 1.8 秒，提前这么多秒停。 */
const CHAPTER_STOP_LEAD_SECONDS = 1.5;
const POSITION_STATE_INTERVAL_MS = 5000;
/** 锁屏、耳机上的快进快退没给秒数时按这个跳，跟播放页的按钮一致。 */
const SKIP_SECONDS = 15;
const LIVE_CLIENT_VERSION = "2026-10-08-handover-off-v7";

type Cursor = { chapterIndex: number; sentenceIndex: number };

/** 连续音频会话的键：同一本书、同一处起点、同一音色、同一套读音纠正才能复用。 */
function liveKey(bookId: string, position: Cursor, voiceName: string, speakKey: string): string {
  return `${bookId}:${position.chapterIndex}:${position.sentenceIndex}:${voiceName}:${speakKey}`;
}

/** 连续音频的文稿里第几句：句子按书里的顺序排，二分查找。 */
function liveSentenceIndex(plan: LivePlan, chapterIndex: number, sentenceIndex: number): number {
  let low = 0;
  let high = plan.sentences.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const item = plan.sentences[middle];
    const order = item.chapterIndex - chapterIndex || item.sentenceIndex - sentenceIndex;
    if (order === 0) return middle;
    if (order < 0) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

/** 文稿里第一句章号大于 chapterIndex 的句子（「本章结束后」在它前面停）。 */
function liveSentenceAfterChapter(plan: LivePlan, chapterIndex: number): LiveSentence | null {
  let low = 0;
  let high = plan.sentences.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (plan.sentences[middle].chapterIndex > chapterIndex) high = middle;
    else low = middle + 1;
  }
  return plan.sentences[low] ?? null;
}
function reusableAudio(ref: { current: HTMLAudioElement | null }): HTMLAudioElement {
  return ref.current ?? new Audio();
}
/**
 * 原生 HLS 连续音频的接手默认关着。线上遥测（D1 audio_telemetry）：2026-10-02 起 7 次接手
 * 全部停在 readyState=1、buffered 为空，一次都没出过声，每次白卡 8 秒再退回分段，听着就是
 * 「听一会儿停一下、转圈加载」。分段一路播下去不会这样。代码留着，排查时在那台设备上执行
 * localStorage.setItem("moting:live-hls", "1") 再重开应用即可打开。
 */
function liveHandoverEnabled(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("moting:live-hls") === "1";
  } catch {
    return false;
  }
}
let liveClientId = "";
function reportLiveClient(stage: "prewarm" | "prewarm-failed" | "legacy-start", reason: string, hls: boolean) {
  // 接手关着时没有可诊断的东西，不发这些遥测。
  if (!liveHandoverEnabled()) return;
  liveClientId ||= crypto.randomUUID().replaceAll("-", "");
  void fetch("/api/sync/live/client", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: liveClientId, stage, reason: reason.slice(0, 96), hls, version: LIVE_CLIENT_VERSION }),
    keepalive: true,
  }).catch(() => undefined);
}
function reportLiveEvent(id: string, audio: HTMLAudioElement, type: string) {
  const url = `/api/sync/live/${id}/event`;
  const body = JSON.stringify({
    type, ct: audio.currentTime, rs: audio.readyState,
    visibility: document.visibilityState,
    buffered: Array.from({ length: Math.min(audio.buffered.length, 4) }, (_, i) => [audio.buffered.start(i), audio.buffered.end(i)]),
    mediaError: audio.error?.code ?? null,
  });
  if (navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }))) return;
  void fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body, keepalive: true,
  }).catch(() => undefined);
}
/** 面板打开时最多顺手准备几个音色。再多就是在替用户瞎猜，白烧合成次数。 */
const MAX_VOICE_PREFETCH = 3;

function locationAfter(
  book: Book,
  chapterIndex: number,
  sentenceIndex: number,
  delta: number
): { chapterIndex: number; sentenceIndex: number } | null {
  let chapter = chapterIndex;
  let sentence = sentenceIndex;
  let remaining = Math.abs(delta);
  const direction = delta >= 0 ? 1 : -1;

  if (!book.chapters.length) return null;

  while (remaining > 0) {
    const sentences = flattenChapter(book.chapters[chapter]);
    sentence += direction;
    if (sentence >= sentences.length) {
      chapter += 1;
      sentence = 0;
    } else if (sentence < 0) {
      chapter -= 1;
      if (chapter >= 0) {
        sentence = flattenChapter(book.chapters[chapter]).length - 1;
      }
    }
    // 走到书的两头就停在端点。这里以前返回 null，调用方直接 return，
    // 于是开头按快退、结尾按快进都是一点反应都没有，看着就像按钮坏了。
    if (chapter < 0) return { chapterIndex: 0, sentenceIndex: 0 };
    if (chapter >= book.chapters.length) {
      const last = book.chapters.length - 1;
      return {
        chapterIndex: last,
        sentenceIndex: Math.max(0, flattenChapter(book.chapters[last]).length - 1),
      };
    }
    remaining -= 1;
  }

  return { chapterIndex: chapter, sentenceIndex: sentence };
}

/**
 * 锁屏后台等网络时不能真的让音频停下来：iOS 一旦静音超过系统给的宽限期就会
 * 回收 audio session，之后 play() 能 resolve 却发不出声音。用这段静音占位撑住
 * 会话，取到真正的音频再切换过去。懒创建一次，进程内复用。
 */
let silentClipUrlCache = "";
function silentClipUrl(): string {
  if (silentClipUrlCache) return silentClipUrlCache;
  const sampleRate = 8000;
  const samples = sampleRate; // 1 秒静音，够循环撑住一次网络等待
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples * 2, true);
  silentClipUrlCache = URL.createObjectURL(
    new Blob([buffer], { type: "audio/wav" })
  );
  return silentClipUrlCache;
}

interface PlayOptions {
  /**
   * 云端分段档位：起播、换音色、跳位置从 0 档（360 字）开始，出声快；接着往下读
   * 一档档变长（1500 字、4800 字）。
   */
  tier?: SpeechTier;
  /** 交接用：音频从这一句对应的时间点开始放，而不是从整段开头。 */
  seekToSentence?: number;
  /** 第几次尝试：云端失败自动重试，始终使用同一云端音色。 */
  attempt?: number;
}

export function useSpeechPlayer({
  getBook,
  settings: rawSettings,
  onProgress,
}: SpeechPlayerOptions): SpeechPlayerState {
  // 设置里可能还存着已经下架的音色或者以前选过的系统语音（旧版本、别的设备同步来的），
  // 一律按默认云端音色读；失败也不切换系统语音。
  const settings = useMemo(() => {
    const voiceURI = normalizeVoiceURI(rawSettings.voiceURI);
    return voiceURI === rawSettings.voiceURI ? rawSettings : { ...rawSettings, voiceURI };
  }, [rawSettings]);
  // 读音纠正只改送去合成的文字。key 进缓存键：规则一改，分段和连续音频都按新文字重来。
  const speech = useMemo(
    () => ({
      speak: speechReplacer(settings.speechReplacements),
      key: replacementKey(settings.speechReplacements),
    }),
    [settings.speechReplacements]
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [location, setLocation] = useState<SpeechLocation | null>(null);
  const [currentSentenceId, setCurrentSentenceId] = useState("");
  const [error, setError] = useState("");
  const [sleepModeState, setSleepModeState] = useState<SleepMode>("off");
  const [sleepDeadline, setSleepDeadline] = useState<number | null>(null);
  const [activeVoiceURI, setActiveVoiceURI] = useState("");
  const [pendingVoiceURI, setPendingVoiceURI] = useState("");
  const [voiceError, setVoiceError] = useState("");
  const [recentVoiceURIs, setRecentVoiceURIs] = useState<string[]>([]);

  const getBookRef = useRef(getBook);
  const settingsRef = useRef(settings);
  const speechRef = useRef(speech);
  const onProgressRef = useRef(onProgress);
  const locationRef = useRef<SpeechLocation | null>(null);
  /** 用户的意图：应该在出声。系统把音频停了（来电、Siri、拔耳机）会被同步成 false。 */
  const playingRef = useRef(false);
  const tokenRef = useRef(0);
  const playAttemptRef = useRef(0);
  const engineRef = useRef<"edge" | "live" | null>(null);
  const sleepModeRef = useRef<SleepMode>("off");
  const sleepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sleepDeadlineRef = useRef<number | null>(null);
  /** 「本章结束后」停在哪一章之后：目录里这一项的最后一章（续页算在内）。 */
  const sleepLastChapterRef = useRef(Number.POSITIVE_INFINITY);
  const startupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trackRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const positionStateAtRef = useRef(0);
  const listenCacheRef = useRef<{ chapters: Book["chapters"]; first: number; listen: ListenChapter } | null>(null);
  const segmentCacheRef = useRef(new Map<string, BookSpeechBlock | null>());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const liveRef = useRef<{ bookId: string; plan: LivePlan; id: string; status: LiveStatus } | null>(null);
  const preparedLiveRef = useRef<{
    key: string;
    plan: LivePlan;
    id?: string;
    url?: string;
    status?: LiveStatus;
    failed?: boolean;
    voice: string;
    controller: AbortController;
  } | null>(null);
  const promoteLiveRef = useRef<(prepared: NonNullable<typeof preparedLiveRef.current>) => void>(() => undefined);
  const clipUrlRef = useRef("");
  /**
   * 正在播的这一段音频、它对应的文本和时间轴。
   * 快进快退只要目标句还在这一段里，就能直接跳时间轴，不必重新合成。
   */
  const playingClipRef = useRef<{
    bookId: string;
    chapterIndex: number;
    segment: BookSpeechBlock;
    clip: SpeechClip;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const waitingForClipRef = useRef(false);
  const activeVoiceRef = useRef("");
  const requestedVoiceRef = useRef(settings.voiceURI);
  const handoverTokenRef = useRef(0);
  const handoverAbortRef = useRef<AbortController | null>(null);
  const handoverPendingRef = useRef(false);
  /**
   * 预取时用的那个位置。交接必须回到同一个锚点去取音频：合成结果是按整段文本缓存的，
   * 换个起始句就是另一段文本、另一个键，预取白做。位置的推进改用 seek 补偿。
   */
  const prefetchAnchorRef = useRef<{
    bookId: string;
    chapterIndex: number;
    sentenceIndex: number;
  } | null>(null);
  const playAtRef = useRef<
    | ((
        bookId: string,
        chapterIndex: number,
        sentenceIndex: number,
        options?: PlayOptions
      ) => void)
    | null
  >(null);

  // 请求与缓存只此一份，整场收听共用，所以换音色来回切能命中已经合成过的音频。
  // 用 useState 的惰性初始化拿这个稳定实例：useMemo 允许被丢弃重算，缓存会跟着白丢。
  const [store] = useState(() => new SpeechClipStore());

  useEffect(() => {
    getBookRef.current = getBook;
  }, [getBook]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    speechRef.current = speech;
  }, [speech]);

  useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);

  const voices: PlayerVoice[] = EDGE_VOICES;

  const clearTimers = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (startupTimerRef.current) {
      clearTimeout(startupTimerRef.current);
      startupTimerRef.current = null;
    }
    if (trackRef.current) {
      clearInterval(trackRef.current);
      trackRef.current = null;
    }
  }, []);

  const releaseClip = useCallback(() => {
    if (clipUrlRef.current) {
      URL.revokeObjectURL(clipUrlRef.current);
      clipUrlRef.current = "";
    }
  }, []);

  /** 丢掉正在进行的音色切换。连点、播完接段、停止都要走这一步。 */
  const cancelHandover = useCallback(() => {
    handoverTokenRef.current += 1;
    handoverAbortRef.current?.abort();
    handoverAbortRef.current = null;
    handoverPendingRef.current = false;
    setPendingVoiceURI("");
  }, []);

  const noteVoiceUsed = useCallback((voiceURI: string) => {
    activeVoiceRef.current = voiceURI;
    setActiveVoiceURI(voiceURI);
    setRecentVoiceURIs((current) => {
      if (current[0] === voiceURI) return current;
      return [voiceURI, ...current.filter((item) => item !== voiceURI)].slice(
        0,
        6
      );
    });
  }, []);

  // 后台播放被系统拦下时不能当成播完：清掉位置的话迷你播放器会消失，
  // 回到前台连「继续」都没得点。只置成暂停，原地等用户点一下。
  const holdForResume = useCallback((message: string) => {
    playingRef.current = false;
    waitingForClipRef.current = false;
    clearTimers();
    abortRef.current?.abort();
    audioRef.current?.pause();
    setIsPlaying(false);
    setIsPaused(true);
    setIsBuffering(false);
    setError(message);
  }, [clearTimers]);

  /** play() 成功不代表媒体时钟开始走；无声卡住时保留位置、恢复可重试状态。 */
  const watchPlayback = useCallback((audio: HTMLAudioElement, startAt = audio.currentTime) => {
    if (startupTimerRef.current) clearTimeout(startupTimerRef.current);
    const token = tokenRef.current;
    const src = audio.src;
    startupTimerRef.current = setTimeout(() => {
      startupTimerRef.current = null;
      if (token !== tokenRef.current || !playingRef.current || audio.src !== src) return;
      if (!audio.ended && (audio.paused || audio.readyState < 2 || Math.abs(audio.currentTime - startAt) < 0.02)) {
        holdForResume("云端音频未能开始播放，点播放重试");
      }
    }, 8000);
  }, [holdForResume]);

  const playAudio = useCallback((audio: HTMLAudioElement, message: string) => {
    const token = tokenRef.current;
    const attempt = ++playAttemptRef.current;
    const src = audio.src;
    audio.muted = false;
    audio.volume = 1;
    void audio.play().catch(() => {
      // 旧 play() 可能在用户暂停、切章或再次恢复后才拒绝，不能把新播放也停掉。
      if (attempt !== playAttemptRef.current || token !== tokenRef.current ||
          audio.src !== src || !playingRef.current) return;
      holdForResume(message);
    });
  }, [holdForResume]);

  const silenceAudio = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.onended = null;
    audio.onerror = null;
    audio.ontimeupdate = null;
    audio.onplaying = null;
    audio.onwaiting = null;
    audio.onplay = null;
    audio.onpause = null;
    audio.onstalled = null;
    audio.removeAttribute("src");
    audio.load();
  }, []);

  const preparePlayback = useCallback(() => {
    const audio = reusableAudio(audioRef);
    audioRef.current = audio;
    if (playingRef.current && !audio.paused) return;
    audio.onended = null;
    audio.onpause = null;
    audio.onplay = null;
    audio.onplaying = null;
    audio.onerror = null;
    audio.ontimeupdate = null;
    playingClipRef.current = null;
    waitingForClipRef.current = true;
    audio.preload = "auto";
    audio.muted = false;
    audio.volume = 1;
    audio.loop = true;
    audio.src = silentClipUrl();
    releaseClip();
    // 这次调用只在点击事件中激活同一个元素；真正音频的播放结果由播放器处理。
    void audio.play().catch(() => undefined);
  }, [releaseClip]);

  /** 目录里这一章（续页并进来）的时长表，锁屏进度条和「拖到第几秒」共用。 */
  const listenFor = useCallback((book: Book, chapterIndex: number): ListenChapter => {
    const range = tocRange(tocIndexes(book.chapters), chapterIndex, book.chapters.length);
    const cached = listenCacheRef.current;
    if (cached && cached.chapters === book.chapters && cached.first === range.first) {
      return cached.listen;
    }
    const listen = listenChapter(book.chapters, range.first, range.last);
    listenCacheRef.current = { chapters: book.chapters, first: range.first, listen };
    return listen;
  }, []);

  /**
   * 锁屏和控制中心上的进度条，跟播放页一样一章一章算、按屏幕时钟给（已经除过倍速）：
   * 位置是这一句的估算起点，加上这一句在真实音频里已经读了多久。
   */
  const updatePositionState = useCallback(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    if (typeof session.setPositionState !== "function") return;
    const at = locationRef.current;
    const book = at ? getBookRef.current(at.bookId) : undefined;
    if (!at || !book) return;
    positionStateAtRef.current = Date.now();
    const rate = Math.max(settingsRef.current.speechRate, 0.1);
    const listen = listenFor(book, at.chapterIndex);
    const sentence = sentenceSeconds(listen, at.chapterIndex, at.sentenceIndex);
    const audio = audioRef.current;
    let startedAt: number | null = null;
    const live = liveRef.current;
    const clip = playingClipRef.current;
    if (engineRef.current === "live" && live && live.bookId === at.bookId) {
      const index = liveSentenceIndex(live.plan, at.chapterIndex, at.sentenceIndex);
      if (index >= 0) startedAt = liveTimeAtChar(live.status, live.plan.sentences[index].start);
    } else if (engineRef.current === "edge" && clip && clip.bookId === at.bookId && !waitingForClipRef.current) {
      const span = spanForBookSentence(clip.segment, at.chapterIndex, at.sentenceIndex);
      if (span) startedAt = timeAt(clip.clip.timeline, span.start);
    }
    const within = audio && startedAt !== null
      ? Math.min(Math.max(0, audio.currentTime - startedAt), sentence.end - sentence.start)
      : 0;
    const duration = Math.max(chapterDuration(listen) / rate, 1);
    const position = Math.min((sentence.start + within) / rate, duration);
    try {
      session.setPositionState({ duration, playbackRate: 1, position });
    } catch {
      // 个别浏览器对参数挑剔，进度条不是必需的。
    }
  }, [listenFor]);

  const clearSleep = useCallback(() => {
    if (sleepTimerRef.current) {
      clearTimeout(sleepTimerRef.current);
      sleepTimerRef.current = null;
    }
    sleepModeRef.current = "off";
    sleepDeadlineRef.current = null;
    sleepLastChapterRef.current = Number.POSITIVE_INFINITY;
    setSleepModeState("off");
    setSleepDeadline(null);
  }, []);

  /** 「本章结束后」跟着用户跳到的位置走：跳到哪一章，就在那一章（续页算在内）读完时停。 */
  const retargetSleepChapter = useCallback((book: Book, chapterIndex: number) => {
    if (sleepModeRef.current !== "chapter") return;
    sleepLastChapterRef.current = tocRange(
      tocIndexes(book.chapters),
      chapterIndex,
      book.chapters.length
    ).last;
  }, []);

  const stop = useCallback(() => {
    tokenRef.current += 1;
    playingRef.current = false;
    engineRef.current = null;
    waitingForClipRef.current = false;
    clearTimers();
    cancelHandover();
    abortRef.current?.abort();
    abortRef.current = null;
    store.cancelPending();
    silenceAudio();
    releaseClip();
    playingClipRef.current = null;
    liveRef.current = null;
    preparedLiveRef.current?.controller.abort();
    preparedLiveRef.current = null;

    // 定时关闭是「这一次收听」的设置，停了就该归零，不然换本书还会在原来的时间点断掉。
    clearSleep();
    // 迷你播放器是由 location 推出来的，不清掉就永远赖在书库上关不掉。
    locationRef.current = null;
    setLocation(null);
    setCurrentSentenceId("");
    setIsPlaying(false);
    setIsPaused(false);
    setIsBuffering(false);
    activeVoiceRef.current = "";
    setActiveVoiceURI("");
    setVoiceError("");
  }, [cancelHandover, clearSleep, clearTimers, releaseClip, silenceAudio, store]);

  /** 把「现在读到哪一句」落到状态和进度上。播放推进和段内快进共用这一条路。 */
  const commitSpan = useCallback(
    (book: Book, chapterIndex: number, span: Pick<SpeechSpan, "sentenceId" | "sentenceIndex">) => {
      if (locationRef.current?.sentenceId === span.sentenceId) return;
      const nextLocation: SpeechLocation = {
        bookId: book.id,
        chapterIndex,
        sentenceIndex: span.sentenceIndex,
        sentenceId: span.sentenceId,
      };
      locationRef.current = nextLocation;
      setLocation(nextLocation);
      setCurrentSentenceId(span.sentenceId);
      onProgressRef.current(
        book.id,
        positionFor(book, chapterIndex, span.sentenceIndex)
      );
      updatePositionState();
    },
    [updatePositionState]
  );

  /** 只挪位置：commitSpan 要的那几样从书里查。 */
  const commitCursor = useCallback(
    (book: Book, cursor: Cursor) => {
      const position = positionFor(book, cursor.chapterIndex, cursor.sentenceIndex);
      commitSpan(book, position.chapterIndex, {
        sentenceId: position.sentenceId,
        sentenceIndex: position.sentenceIndex,
      });
    },
    [commitSpan]
  );

  /**
   * 章节分段的结果按（章, 引擎, 档位, 读音纠正）缓存，滚动播放时不必每段重排一次全章。
   * 云端分段一律可以跨章：「本章结束后」靠播放进度在换章前的静音里停，不靠切段。
   */
  const segmentFor = useCallback(
    (
      book: Book,
      chapterIndex: number,
      sentenceIndex: number,
      engine: SpeechEngine,
      tier: SpeechTier
    ): BookSpeechBlock | null => {
      const { speak, key: speakKey } = speechRef.current;
      const key = `${book.id}:${engine}:${tier}:${speakKey}:${chapterIndex}:${sentenceIndex}`;
      const cached = segmentCacheRef.current.get(key);
      if (cached !== undefined) return cached;
      const segment = segmentFromBook(book, chapterIndex, sentenceIndex, engine, tier, true, speak);
      // 缓存无上限会随着长书一直涨，超过这个数就整盘丢掉重来，代价只是重排一次。
      if (segmentCacheRef.current.size > 512) segmentCacheRef.current.clear();
      segmentCacheRef.current.set(key, segment);
      return segment;
    },
    []
  );

  /** 暂停在原地，位置、迷你播放条都留着。用户点暂停、定时关闭到点都走这里。 */
  const pause = useCallback(() => {
    if (!playingRef.current) return;
    const engine = engineRef.current;
    // 先改意图再停元素：pause 事件的监听靠它分辨是我们停的还是系统停的。
    playingRef.current = false;
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (startupTimerRef.current) {
      clearTimeout(startupTimerRef.current);
      startupTimerRef.current = null;
    }
    if (engine === "live") {
      audioRef.current?.pause();
    } else {
      abortRef.current?.abort();
      cancelHandover();
      audioRef.current?.pause();
    }
    setIsPlaying(false);
    setIsPaused(true);
    setIsBuffering(false);
    updatePositionState();
  }, [cancelHandover, updatePositionState]);

  /**
   * 定时关闭到点：暂停而不是停止，迷你播放条和位置都留着。「本章结束后」把位置挪到下一章
   * 开头（音频也跳过去），继续时从那里读。
   */
  const pauseForSleep = useCallback(
    (resumeAt: Cursor | null, seekTo?: number) => {
      pause();
      clearSleep();
      if (seekTo !== undefined && audioRef.current) {
        try {
          audioRef.current.currentTime = seekTo;
        } catch {
          // 写不进去就从停下的地方接着读，多听一秒静音而已。
        }
      }
      const at = locationRef.current;
      const book = at ? getBookRef.current(at.bookId) : undefined;
      if (resumeAt && book) commitCursor(book, resumeAt);
    },
    [clearSleep, commitCursor, pause]
  );
  const pauseForSleepRef = useRef(pauseForSleep);
  useEffect(() => {
    pauseForSleepRef.current = pauseForSleep;
  }, [pauseForSleep]);

  const playAt = useCallback(
    (
      bookId: string,
      chapterIndex: number,
      sentenceIndex: number,
      options: PlayOptions = {}
    ) => {
      const book = getBookRef.current(bookId);
      if (!book) {
        setError("这本书已经不在书架中");
        stop();
        return;
      }

      const chapter = book.chapters[chapterIndex];
      const tier = options.tier ?? 0;
      const attempt = options.attempt ?? 0;
      const segment = chapter
        ? segmentFor(book, chapterIndex, sentenceIndex, "edge", tier)
        : null;

      if (!chapter || !segment) {
        const next = nextBookSentence(book, chapterIndex + 1, 0);
        if (next) {
          playAtRef.current?.(bookId, next.chapterIndex, next.sentenceIndex, { tier });
          return;
        }
        setError("当前章节没有可朗读内容");
        stop();
        return;
      }

      tokenRef.current += 1;
      const token = tokenRef.current;
      liveRef.current = null;
      if (audioRef.current) {
        audioRef.current.ontimeupdate = null;
        audioRef.current.onplaying = null;
        audioRef.current.onwaiting = null;
        audioRef.current.onplay = null;
        audioRef.current.onpause = null;
        audioRef.current.onstalled = null;
      }
      clearTimers();
      abortRef.current?.abort();
      abortRef.current = null;
      // 这里刻意不清空 audio：把 src 摘掉等于告诉系统「这次播放结束了」，
      // 媒体会话一断，后台就再没资格起播下一段。真要换源时直接覆盖 src 即可。

      setError("");

      const applySpan = (span: SpeechSpan) => {
        if (token !== tokenRef.current) return;
        commitSpan(book, (span as BookSpeechSpan).chapterIndex ?? chapterIndex, span);
      };
      const sleepDue = () =>
        sleepDeadlineRef.current !== null && Date.now() >= sleepDeadlineRef.current;

      // 交接时从中途起播，高亮也要直接落在那一句上，不能从段首开始往下爬。
      const startSpan =
        (options.seekToSentence === undefined
          ? null
          : spanForBookSentence(segment, chapterIndex, options.seekToSentence)) ?? segment.spans[0];
      applySpan(startSpan);

      const finishSegment = () => {
        if (token !== tokenRef.current || !playingRef.current) return;
        clearTimers();
        // 这一段自然读完时如果还在等切换的音频，那次准备已经没用了：
        // 从下一句直接用新音色起播更快，也不会两段音频抢着播。
        if (handoverPendingRef.current) cancelHandover();
        const last = segment.spans[segment.spans.length - 1];
        const next = nextBookSentence(book, last.chapterIndex, last.sentenceIndex + 1);
        if (!next) { applySpan(last); stop(); return; }
        if (sleepDue() || (sleepModeRef.current === "chapter" && next.chapterIndex > sleepLastChapterRef.current)) {
          pauseForSleepRef.current(next);
          return;
        }
        playAtRef.current?.(bookId, next.chapterIndex, next.sentenceIndex, {
          tier: nextTier(tier),
        });
      };

      const startEdge = () => {
        engineRef.current = "edge";
        const voiceName = edgeVoiceName(settingsRef.current.voiceURI);

        const prefetchNext = () => {
          const last = segment.spans[segment.spans.length - 1];
          const continuation = nextBookSentence(book, last.chapterIndex, last.sentenceIndex + 1);
          if (!continuation) return;
          if (sleepModeRef.current === "chapter" && continuation.chapterIndex > sleepLastChapterRef.current) return;

          // 预取的是下一档的精确续点（360 字之后是 1500 字，再之后是长批次），
          // 不能再预取一个短块，否则这一段读完还要再等一次网络。
          const next = segmentFor(book, continuation.chapterIndex, continuation.sentenceIndex, "edge", nextTier(tier));
          if (next) store.prefetch(next.text, voiceName);
        };

        /**
         * 系统打断（来电、Siri、别的应用出声、拔耳机）只暂停元素、不通知页面：同步成暂停，
         * 界面才不会还显示在播，锁屏的播放键才按得动。不自动续播——拔了耳机不该外放。
         */
        const syncSystemPause = (audio: HTMLAudioElement) => () => {
          if (token !== tokenRef.current || !playingRef.current) return;
          if (audio.ended || !audio.paused || !audio.getAttribute("src")) return;
          playingRef.current = false;
          setIsPlaying(false);
          setIsPaused(true);
          setIsBuffering(false);
          updatePositionState();
        };

        const beginClip = (clip: SpeechClip) => {
          const audio = audioRef.current ?? new Audio();
          audioRef.current = audio;
          audio.loop = false;
          audio.onended = finishSegment;
          audio.onerror = () => {
            if (token !== tokenRef.current) return;
            store.evict(segment.text, voiceName);
            playingClipRef.current = null;
            holdForResume("这一段云端音频没能播出来，点播放重试");
          };
          audio.onplaying = () => {
            if (token !== tokenRef.current || !playingRef.current || audio.src !== clipUrlRef.current) return;
            setIsBuffering(false);
            setError("");
            noteVoiceUsed(resolvedEdgeVoiceURI(settingsRef.current.voiceURI));
          };
          audio.onpause = syncSystemPause(audio);
          audio.onplay = () => {
            // 耳机、车机上的播放键没经过 Media Session，系统直接把声音续上了。
            if (token !== tokenRef.current || playingRef.current || audio.src !== clipUrlRef.current) return;
            playingRef.current = true;
            setIsPlaying(true);
            setIsPaused(false);
            setError("");
          };
          const previous = clipUrlRef.current;
          const url = URL.createObjectURL(clip.audio);
          clipUrlRef.current = url;
          audio.src = url;
          if (previous) URL.revokeObjectURL(previous);
          audio.preload = "auto";
          audio.defaultPlaybackRate = settingsRef.current.speechRate;
          audio.playbackRate = settingsRef.current.speechRate;

          // 交接：从当前这句对应的时刻起播。src 刚换上时 currentTime 可能还写不进去，
          // 所以元数据到位后再补一次，写两遍是幂等的。
          const seekSpan =
            options.seekToSentence === undefined
              ? null
              : spanForBookSentence(segment, chapterIndex, options.seekToSentence);
          if (seekSpan && seekSpan.start > 0) {
            const seconds = timeAt(clip.timeline, seekSpan.start);
            const applySeek = () => {
              if (token !== tokenRef.current) return;
              try {
                audio.currentTime = seconds;
              } catch {
                // 拿不到就从段首放，顶多重听几句，不能因此不出声。
              }
            };
            applySeek();
            audio.addEventListener("loadedmetadata", applySeek, { once: true });
          }

          waitingForClipRef.current = false;
          setIsBuffering(true);
          playingClipRef.current = { bookId, chapterIndex, segment, clip };
          setVoiceError("");
          watchPlayback(audio, seekSpan ? timeAt(clip.timeline, seekSpan.start) : 0);
          playAudio(audio, "播放被系统打断了，点一下继续");

          const tick = () => {
            if (token !== tokenRef.current || audio.paused || !playingRef.current) return;
            const time = audio.currentTime;
            const span = spanAt(segment.spans, charIndexAt(clip.timeline, time));
            if (sleepDue()) {
              applySpan(span);
              pauseForSleepRef.current(null);
              return;
            }
            // 「本章结束后」在这一段里的停点：下一章第一句的开头，提前一点停在换章的静音里。
            const stopAt = sleepModeRef.current === "chapter"
              ? segment.spans.find((span) => span.chapterIndex > sleepLastChapterRef.current)
              : undefined;
            if (stopAt) {
              const seconds = timeAt(clip.timeline, stopAt.start);
              if (time >= seconds - CHAPTER_STOP_LEAD_SECONDS) {
                pauseForSleepRef.current(
                  { chapterIndex: stopAt.chapterIndex, sentenceIndex: stopAt.sentenceIndex },
                  seconds
                );
                return;
              }
            }
            // 停点判断在前：已经读过了停点（熄屏后这一下来得晚）也不能先把下一章记成进度。
            applySpan(span);
            if (Date.now() - positionStateAtRef.current > POSITION_STATE_INTERVAL_MS) {
              updatePositionState();
            }
          };
          trackRef.current = setInterval(tick, HIGHLIGHT_INTERVAL_MS);
          // 熄屏后定时器会被节流，timeupdate 跟着媒体管线走，高亮和定时关闭靠它兜底。
          audio.ontimeupdate = tick;

          prefetchNext();
          const prepared = preparedLiveRef.current;
          if (prepared?.status?.ready) promoteLiveRef.current(prepared);
        };

        // 缓存命中必须走同步路径：中间但凡有一次 await，后台的 play() 就会被 iOS
        // 当成新的自动播放请求拦掉。这条也是「1 秒内出声」唯一站得住的依据。
        const ready = store.peek(segment.text, voiceName);
        if (ready) {
          beginClip(ready);
          return;
        }

        // 锁屏后台等网络时绝不能真的停音频，否则 audio session 会被系统回收，
        // 之后 play() 能成功但发不出声音。改放静音占位撑住会话，取到音频再切换。
        const waitingAudio = audioRef.current ?? new Audio();
        audioRef.current = waitingAudio;
        waitingAudio.onended = null;
        waitingAudio.onerror = null;
        waitingAudio.onpause = syncSystemPause(waitingAudio);
        waitingAudio.loop = true;
        waitingAudio.src = silentClipUrl();
        playingClipRef.current = null;
        waitingForClipRef.current = true;
        setIsBuffering(true);
        playAudio(waitingAudio, "播放未能启动，点播放重试");

        const controller = new AbortController();
        abortRef.current = controller;

        store
          .request(segment.text, voiceName, {
            priority: true,
            signal: controller.signal,
          })
          .then((clip) => {
            // 等的时候被暂停了：音频已经进了缓存，继续时同步命中。
            if (token !== tokenRef.current || !playingRef.current) return;
            beginClip(clip);
          })
          .catch((reason: unknown) => {
            if (token !== tokenRef.current || !playingRef.current) return;
            if (isAbortError(reason) && controller.signal.aborted) return;
            const serviceDown =
              !(reason instanceof SpeechClipError) || reason.serviceDown;
            if (serviceDown && attempt < 2) {
              // 先别急着换声音：大多是一时的网络抖动。静音占位接着撑住会话，等一下再试一次。
              retryTimerRef.current = setTimeout(() => {
                retryTimerRef.current = null;
                if (token !== tokenRef.current || !playingRef.current) return;
                playAtRef.current?.(bookId, chapterIndex, sentenceIndex, { ...options, attempt: attempt + 1 });
              }, EDGE_RETRY_DELAY_MS * (attempt + 1));
              return;
            }
            holdForResume(serviceDown
              ? "云端语音暂时连不上，点播放重试"
              : "这一段云端音频暂时不可用，点播放重试");
          });
      };

      playingRef.current = true;
      setIsPlaying(true);
      setIsPaused(false);

      startEdge();
    },
    [
      cancelHandover,
      clearTimers,
      commitSpan,
      holdForResume,
      noteVoiceUsed,
      playAudio,
      segmentFor,
      stop,
      store,
      updatePositionState,
      watchPlayback,
    ]
  );

  useEffect(() => {
    playAtRef.current = playAt;
  }, [playAt]);

  /**
   * 换音色：不打断当前播放，先把新音色的短首段备好，就绪后在句子边界交接。
   *
   * 准备期间原音色继续读，位置会往前走，所以交接时要拿「此刻」的位置去对齐；
   * 已经走出这一段的（跨段、跨章）就判定候选音频过期，按现位置重开，
   * 绝不直接播那段旧音频——那会让用户听见明显的倒退或整段重复。
   */
  const runHandover = useCallback(
    (voiceURI: string) => {
      const at = locationRef.current;
      if (!at) return;

      handoverTokenRef.current += 1;
      const handoverToken = handoverTokenRef.current;
      handoverAbortRef.current?.abort();
      handoverAbortRef.current = null;
      setVoiceError("");

      const book = getBookRef.current(at.bookId);
      const chapter = book?.chapters[at.chapterIndex];
      let segment = chapter
        ? segmentFor(book!, at.chapterIndex, at.sentenceIndex, "edge", 0)
        : null;
      if (!chapter || !segment) {
        handoverPendingRef.current = false;
        setPendingVoiceURI("");
        playAt(at.bookId, at.chapterIndex, at.sentenceIndex, { tier: 0 });
        return;
      }

      // 打开面板到点下去这几秒，原音色还在往前读。如果预取那一段仍然盖得住此刻
      // 这一句、而且确实已经备好了，就回到预取的锚点取音频，再 seek 到当前句——
      // 这才是预取真正兑现的地方。盖不住（跨段、跨章）就老实重合成。
      let anchorSentence = at.sentenceIndex;
      const anchor = prefetchAnchorRef.current;
      if (
        anchor &&
        anchor.bookId === at.bookId &&
        anchor.chapterIndex === at.chapterIndex &&
        anchor.sentenceIndex <= at.sentenceIndex
      ) {
        const prepared = segmentFor(book!, at.chapterIndex, anchor.sentenceIndex, "edge", 0);
        if (
          prepared &&
          spanForBookSentence(prepared, at.chapterIndex, at.sentenceIndex) &&
          store.has(prepared.text, edgeVoiceName(voiceURI))
        ) {
          anchorSentence = anchor.sentenceIndex;
          segment = prepared;
        }
      }

      handoverPendingRef.current = true;
      setPendingVoiceURI(resolvedEdgeVoiceURI(voiceURI));

      const controller = new AbortController();
      handoverAbortRef.current = controller;

      store
        .request(segment.text, edgeVoiceName(voiceURI), {
          priority: true,
          signal: controller.signal,
        })
        .then(() => {
          if (handoverToken !== handoverTokenRef.current) return;
          handoverAbortRef.current = null;
          handoverPendingRef.current = false;
          setPendingVoiceURI("");

          const now = locationRef.current;
          if (!now || now.bookId !== at.bookId) return;

          const stillInside =
            now.chapterIndex === at.chapterIndex &&
            spanForBookSentence(segment, now.chapterIndex, now.sentenceIndex) !== null;
          if (stillInside) {
            // 音频已经在缓存里，playAt 会同步命中，然后 seek 到此刻这一句。
            playAt(at.bookId, at.chapterIndex, anchorSentence, {
              tier: 0,
              seekToSentence: now.sentenceIndex,
            });
          } else {
            playAt(now.bookId, now.chapterIndex, now.sentenceIndex, { tier: 0 });
          }
        })
        .catch((reason: unknown) => {
          if (handoverToken !== handoverTokenRef.current) return;
          handoverAbortRef.current = null;
          handoverPendingRef.current = false;
          setPendingVoiceURI("");
          if (isAbortError(reason)) return;
          // 失败就留在原音色上继续读，别把正在听的这段也搞停了。
          setVoiceError(
            reason instanceof SpeechClipError && !reason.serviceDown
              ? "这个音色暂时合成不出来，仍在用原来的声音"
              : "切换音色失败，仍在用原来的声音"
          );
        });
    },
    [playAt, segmentFor, store]
  );

  const runHandoverRef = useRef(runHandover);
  useEffect(() => {
    runHandoverRef.current = runHandover;
  }, [runHandover]);

  // 用户点了另一个音色。播放中立刻走交接；暂停或停止时只记下来，
  // 等下一次播放才生效——这里擅自起播会把「只是想换个声音」变成「突然出声」。
  useEffect(() => {
    const next = settings.voiceURI;
    if (next === requestedVoiceRef.current) return;
    requestedVoiceRef.current = next;
    if (!playingRef.current || !locationRef.current) return;
    const resolved = isEdgeVoiceURI(next) || !next ? resolvedEdgeVoiceURI(next) : next;
    if (resolved === activeVoiceRef.current) return;
    runHandoverRef.current(next);
  }, [settings.voiceURI]);

  const retryVoiceSwitch = useCallback(() => {
    setVoiceError("");
    if (!playingRef.current || !locationRef.current) return;
    runHandoverRef.current(settingsRef.current.voiceURI);
  }, []);

  /**
   * 打开音色面板时顺手准备几个候选的短首段。
   * 只准备当前位置附近这一小段，控制在 MAX_VOICE_PREFETCH 个以内，
   * 并发由 store 把着，正在播放的请求永远插队在前。
   */
  const prefetchVoices = useCallback(
    (voiceURIs: string[]) => {
      const at = locationRef.current;
      if (!at) return;
      const book = getBookRef.current(at.bookId);
      const chapter = book?.chapters[at.chapterIndex];
      if (!chapter) return;
      const segment = segmentFor(book!, at.chapterIndex, at.sentenceIndex, "edge", 0);
      if (!segment) return;
      prefetchAnchorRef.current = {
        bookId: at.bookId,
        chapterIndex: at.chapterIndex,
        sentenceIndex: at.sentenceIndex,
      };

      const seen = new Set<string>();
      for (const voiceURI of voiceURIs) {
        if (!isEdgeVoiceURI(voiceURI) && voiceURI) continue;
        const name = edgeVoiceName(voiceURI);
        if (seen.has(name)) continue;
        seen.add(name);
        if (seen.size > MAX_VOICE_PREFETCH) break;
        if (store.has(segment.text, name)) continue;
        store.prefetch(segment.text, name);
      }
    },
    [segmentFor, store]
  );

  const cancelVoicePrefetch = useCallback(() => {
    store.cancelPending();
  }, [store]);

  /**
   * 把某个位置的首段提前备好。
   *
   * 点下播放键到出声这段等待，几乎全花在首段合成加下载上（实测 360 字约 5 秒）。
   * 进到播放页多半就是要听，而从进页面到真正点下去总有几秒，正好拿来盖住这段耗时：
   * 备中了的话 playAt 里 store.peek 会同步命中，立刻出声。
   * 没备完也不亏——playAt 用同一个缓存键请求时会并进这条正在飞的请求，不会重来一遍。
   */
  const prefetchStart = useCallback(
    (book: Book, position: BookPosition, forPlayback = false) => {
      // 正在播的时候没什么可备的，接下一段自有 prefetchNext 管。
      if (!forPlayback && (playingRef.current || waitingForClipRef.current)) return;
      const voiceURI = settingsRef.current.voiceURI;
      if (voiceURI && !isEdgeVoiceURI(voiceURI)) {
        reportLiveClient("prewarm-failed", "unsupported-voice", false);
        return;
      }
      const voiceName = edgeVoiceName(voiceURI);
      const supportsHls = liveHandoverEnabled() && typeof document !== "undefined" &&
        !!document.createElement("audio").canPlayType("application/vnd.apple.mpegurl");
      reportLiveClient("prewarm", supportsHls ? "native-hls" : "no-native-hls", supportsHls);
      if (supportsHls) {
        const { speak, key: speakKey } = speechRef.current;
        const key = liveKey(book.id, position, voiceName, speakKey);
        if (preparedLiveRef.current?.key === key && !(forPlayback && preparedLiveRef.current.failed)) return;
        preparedLiveRef.current?.controller.abort();
        const plan = makeLivePlan(book, position, undefined, speak);
        if (plan.sentences.length) {
          const prepared = { key, plan, voice: voiceName, controller: new AbortController() } as NonNullable<typeof preparedLiveRef.current>;
          preparedLiveRef.current = prepared;
          void (async () => {
            try {
              const response = await fetch("/api/sync/live/session", {
                method: "POST", headers: { "content-type": "application/json" },
                // format 2：文字带段落、标题、换章的结构，Worker 据此在拼接处留停顿。
                body: JSON.stringify({ text: plan.text, voice: voiceName, format: STRUCTURED_SPEECH_FORMAT }),
                signal: prepared.controller.signal,
              });
              if (!response.ok) throw new Error(`音频会话返回 ${response.status}`);
              const session = await response.json() as { id: string; url: string };
              prepared.id = session.id;
              prepared.url = session.url;
              for (let attempt = 0; attempt < 60 && !prepared.controller.signal.aborted; attempt++) {
                const statusResponse = await fetch(`/api/sync/live/${session.id}/status`, {
                  signal: prepared.controller.signal,
                });
                if (!statusResponse.ok) throw new Error(`音频状态返回 ${statusResponse.status}`);
                prepared.status = await statusResponse.json() as LiveStatus;
                if (prepared.status.ready || prepared.status.complete) {
                  promoteLiveRef.current(prepared);
                  if (!playingRef.current || engineRef.current !== "edge" ||
                      prepared.voice !== edgeVoiceName(settingsRef.current.voiceURI)) return;
                  // The short opening may already be ahead of this first HLS window; wait for more audio.
                }
                await new Promise<void>(resolve => setTimeout(resolve, attempt < 15 ? 1000 : 2000));
              }
              prepared.failed = true;
            } catch (error) {
              if (!prepared.controller.signal.aborted) {
                prepared.failed = true;
                reportLiveClient("prewarm-failed", error instanceof Error ? error.message : "request-failed", true);
              }
              // Offline and unauthenticated readers retain the existing TTS player.
            }
          })();
        } else reportLiveClient("prewarm-failed", "no-sentences", true);
      }
      // 这里收整本书而不是 bookId：调用方（播放页）手里本来就是这本书的整本，不用再查一次。
      const chapter = book.chapters[position.chapterIndex];
      if (!chapter) return;
      // 必须和 playAt 起播时算出来的那一段完全一致，否则是另一个缓存键，白备。
      const segment = segmentFor(book, position.chapterIndex, position.sentenceIndex, "edge", 0);
      if (!segment) return;
      if (store.has(segment.text, voiceName)) return;
      store.prefetch(segment.text, voiceName);
    },
    [segmentFor, store]
  );

  const startLive = useCallback((book: Book, prepared: NonNullable<typeof preparedLiveRef.current>, position?: BookPosition, offset = 0): boolean => {
    if (prepared.failed || !prepared.id || !prepared.url || !prepared.status?.ready) return false;
    const first = position
      ? prepared.plan.sentences[liveSentenceIndex(prepared.plan, position.chapterIndex, position.sentenceIndex)]
      : prepared.plan.sentences[0];
    if (!first) return false;
    const seekTime = liveTimeAtChar(prepared.status, Math.min(first.end - 1, first.start + offset));
    if (seekTime === null || (!prepared.status.complete && prepared.status.duration - seekTime < 10)) return false;
    tokenRef.current++;
    clearTimers();
    abortRef.current?.abort();
    cancelHandover();
    releaseClip();
    playingClipRef.current = null;
    // Reuse the element activated by the user's play gesture; a fresh element loses that grant on iOS.
    const audio = reusableAudio(audioRef);
    audio.onended = null;
    audio.onerror = null;
    audio.ontimeupdate = null;
    audio.onpause = null;
    audio.onplay = null;
    audio.onwaiting = null;
    audio.onstalled = null;
    audio.onplaying = null;
    audio.loop = false;
    audio.src = prepared.url;
    audio.playbackRate = settingsRef.current.speechRate;
    audioRef.current = audio;
    const id = prepared.id;
    const live = { bookId: book.id, plan: prepared.plan, id, status: prepared.status };
    let started = false;
    let awaitingSeek = seekTime > 0 || !!position;
    let lastTime = seekTime;
    let lastAdvance = Date.now();
    liveRef.current = live;
    engineRef.current = "live";
    playingRef.current = true;
    waitingForClipRef.current = false;
    setIsPlaying(true);
    setIsPaused(false);
    setIsBuffering(true);
    setError("");
    noteVoiceUsed(resolvedEdgeVoiceURI(settingsRef.current.voiceURI));
    commitSpan(book, first.chapterIndex, first);
    const update = () => {
      if (liveRef.current !== live) return;
      const at = liveLocationAt(live.plan, live.status, audio.currentTime);
      // Changing src emits a timeupdate at zero before loadedmetadata permits seeking.
      // Preserve the handover location until the media element reaches the intended offset.
      if (awaitingSeek) {
        if (!started || audio.seeking || audio.readyState < 2 || audio.currentTime < seekTime - 0.0001 || (at && at.start < first.start)) return;
        awaitingSeek = false;
      }
      if (audio.currentTime > lastTime + 0.05) { lastTime = audio.currentTime; lastAdvance = Date.now(); }
      // 定时关闭先于记进度判断：熄屏后这一下可能来得晚，已经读过了停点也不能先把下一章记成进度。
      if (playingRef.current && !audio.paused) {
        // 熄屏后定时器会被节流，timeupdate 跟着媒体管线走，到点检查放在这里兜底。
        if (sleepDeadlineRef.current !== null && Date.now() >= sleepDeadlineRef.current) {
          if (at) commitSpan(book, at.chapterIndex, at);
          pauseForSleepRef.current(null);
          return;
        }
        // 「本章结束后」：下一章第一句开头之前一点停，正好停在换章的静音里；音频跳到下一章开头，
        // 继续时从那里读。
        if (sleepModeRef.current === "chapter") {
          const boundary = liveSentenceAfterChapter(live.plan, sleepLastChapterRef.current);
          const seconds = boundary && liveTimeAtChar(live.status, boundary.start);
          if (boundary && seconds !== null && audio.currentTime >= seconds - CHAPTER_STOP_LEAD_SECONDS) {
            pauseForSleepRef.current(
              { chapterIndex: boundary.chapterIndex, sentenceIndex: boundary.sentenceIndex },
              seconds
            );
            return;
          }
        }
      }
      if (at) commitSpan(book, at.chapterIndex, at);
      if (playingRef.current && Date.now() - positionStateAtRef.current > POSITION_STATE_INTERVAL_MS) updatePositionState();
    };
    const refresh = async () => {
      try {
        const response = await fetch(`/api/sync/live/${id}/status`);
        if (response.ok && liveRef.current === live) live.status = await response.json() as LiveStatus;
        update();
      } catch { /* The native media requests continue independently of this diagnostic poll. */ }
    };
    const fallback = (reason: string) => {
      if (liveRef.current !== live || !playingRef.current) return;
      prepared.failed = true;
      reportLiveClient("legacy-start", `native-fallback:${reason}`, true);
      update();
      const at = locationRef.current;
      if (at?.bookId === book.id) playAtRef.current?.(book.id, at.chapterIndex, at.sentenceIndex, { tier: 0 });
    };
    const applySeek = () => {
      if (liveRef.current !== live) return;
      try { audio.currentTime = seekTime; } catch { /* Retry when metadata arrives. */ }
    };
    if (seekTime > 0) {
      applySeek();
      audio.addEventListener("loadedmetadata", applySeek, { once: true });
    }
    audio.ontimeupdate = update;
    audio.onplay = () => {
      reportLiveEvent(id, audio, "play");
      // 耳机、车机上的播放键没经过 Media Session，系统直接把声音续上了。
      if (liveRef.current !== live || playingRef.current || audio.paused) return;
      playingRef.current = true;
      setIsPlaying(true);
      setIsPaused(false);
      setError("");
    };
    audio.onpause = () => {
      lastAdvance = Date.now(); reportLiveEvent(id, audio, "pause");
      // 系统打断（来电、Siri、别的应用出声、拔耳机）只暂停元素、不通知页面：同步成暂停，
      // 界面才不会还显示在播，锁屏的播放键才按得动。不自动续播——拔了耳机不该外放。
      if (liveRef.current !== live || !playingRef.current) return;
      if (audio.ended || audio.error || !audio.paused) return;
      playingRef.current = false;
      setIsPlaying(false);
      setIsPaused(true);
      setIsBuffering(false);
      updatePositionState();
    };
    audio.onstalled = () => reportLiveEvent(id, audio, "stalled");
    audio.onplaying = () => {
      started = true;
      lastAdvance = Date.now();
      if (liveRef.current === live) setIsBuffering(false);
      reportLiveEvent(id, audio, "playing");
    };
    audio.onwaiting = () => {
      if (liveRef.current === live) { setIsBuffering(true); void refresh(); }
      reportLiveEvent(id, audio, "waiting");
    };
    audio.onerror = () => {
      reportLiveEvent(id, audio, "error");
      fallback("media-error");
    };
    audio.onended = () => {
      reportLiveEvent(id, audio, "ended");
      if (liveRef.current !== live || !playingRef.current) return;
      update();
      if (!live.status.complete || audio.currentTime < live.status.duration - 1) { fallback("early-end"); return; }
      const last = live.plan.sentences.at(-1)!;
      const next = nextBookSentence(book, last.chapterIndex, last.sentenceIndex + 1);
      if (!next) { stop(); return; }
      if ((sleepDeadlineRef.current !== null && Date.now() >= sleepDeadlineRef.current) ||
          (sleepModeRef.current === "chapter" && next.chapterIndex > sleepLastChapterRef.current)) {
        pauseForSleepRef.current(next);
        return;
      }
      playAtRef.current?.(book.id, next.chapterIndex, next.sentenceIndex, { tier: 0 });
    };
    trackRef.current = setInterval(() => {
      if (liveRef.current !== live || document.visibilityState !== "visible") return;
      update();
      void refresh();
      if (playingRef.current && !audio.paused && Date.now() - lastAdvance > 12_000) fallback("stalled");
    }, 3000);
    // Called in the same user gesture as start(): Safari can activate native playback.
    playAudio(audio, "播放被系统拦下，点一下继续");
    setTimeout(() => {
      if (liveRef.current !== live || !playingRef.current || started || document.visibilityState !== "visible") return;
      reportLiveEvent(id, audio, "error");
      // Native HLS can be advertised as "maybe" but never reach HAVE_CURRENT_DATA.
      // The old player is still warmed and can be reused without trapping the user.
      fallback("startup-timeout");
    }, 8000);
    return true;
  }, [cancelHandover, clearTimers, commitSpan, noteVoiceUsed, playAudio, releaseClip, stop, updatePositionState]);

  useEffect(() => {
    promoteLiveRef.current = (prepared) => {
      if (prepared.failed || preparedLiveRef.current !== prepared || !playingRef.current || engineRef.current !== "edge" ||
          prepared.voice !== edgeVoiceName(settingsRef.current.voiceURI) || handoverPendingRef.current) return;
      const at = locationRef.current;
      const book = at && getBookRef.current(at.bookId);
      if (!at || !book || prepared.plan.sentences[0]?.bookId !== book.id) return;
      const clip = playingClipRef.current;
      const span = clip && spanForBookSentence(clip.segment, at.chapterIndex, at.sentenceIndex);
      const offset = span && audioRef.current && !waitingForClipRef.current
        ? Math.max(0, charIndexAt(clip!.clip.timeline, audioRef.current.currentTime) - span.start) : 0;
      startLive(book, prepared, positionFor(book, at.chapterIndex, at.sentenceIndex), offset);
    };
  }, [startLive]);

  // 从后台回到前台时对一下账：后台期间漏掉的 pause 事件、到了点的定时关闭在这里补上。
  useEffect(() => {
    const onVisibility = () => {
      const live = liveRef.current;
      const audio = audioRef.current;
      if (live && audio) reportLiveEvent(live.id, audio, "visibility");
      if (document.visibilityState !== "visible" || !playingRef.current || !audio) return;
      const engine = engineRef.current;
      const silenced =
        (engine === "live" || (engine === "edge" && !waitingForClipRef.current)) &&
        audio.paused && !audio.ended && !audio.error;
      if (silenced) {
        playingRef.current = false;
        setIsPlaying(false);
        setIsPaused(true);
        setIsBuffering(false);
        updatePositionState();
        return;
      }
      if (sleepDeadlineRef.current !== null && Date.now() >= sleepDeadlineRef.current) {
        pauseForSleepRef.current(null);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [updatePositionState]);

  const start = useCallback(
    (bookId: string, position?: BookPosition) => {
      const book = getBookRef.current(bookId);
      if (!book) return;
      cancelHandover();
      setVoiceError("");
      const nextPosition =
        position ?? book.listeningPosition ?? initialPosition(book);
      retargetSleepChapter(book, nextPosition.chapterIndex);
      // Starting from the home card or reader must prepare HLS too, even without visiting the player page.
      prefetchStart(book, nextPosition, true);
      const prepared = preparedLiveRef.current;
      const key = liveKey(book.id, nextPosition, edgeVoiceName(settingsRef.current.voiceURI), speechRef.current.key);
      if (prepared?.key === key && startLive(book, prepared)) return;
      reportLiveClient("legacy-start", !prepared ? "no-prewarm" : prepared.key !== key ? "position-changed" :
        !prepared.id ? "session-pending" : !prepared.status?.ready ? `buffer-${Math.round(prepared.status?.duration ?? 0)}` : "not-playable",
        !!document.createElement("audio").canPlayType("application/vnd.apple.mpegurl"));
      playAt(bookId, nextPosition.chapterIndex, nextPosition.sentenceIndex, { tier: 0 });
    },
    [cancelHandover, playAt, prefetchStart, retargetSleepChapter, startLive]
  );

  const toggle = useCallback(() => {
    const current = locationRef.current;
    if (!current) return;
    if (playingRef.current) {
      pause();
      return;
    }

    if (engineRef.current === "live") {
      const audio = audioRef.current;
      if (!audio) return;
      // 暂停期间换过音色，或者连续音频已经坏了、放完了：从这一句用老路径重开，
      // 连续音频准备好了会再接过去。
      const voiceChanged =
        activeVoiceRef.current !== "" &&
        activeVoiceRef.current !== resolvedEdgeVoiceURI(settingsRef.current.voiceURI);
      if (voiceChanged || audio.error || audio.ended) {
        playAt(current.bookId, current.chapterIndex, current.sentenceIndex, { tier: 0 });
        return;
      }
      playingRef.current = true;
      setIsPlaying(true);
      setIsPaused(false);
      setError("");
      playAudio(audio, "播放被系统拦下，点一下继续");
      updatePositionState();
      return;
    }

    // 暂停期间换过音色：恢复时不能把旧音色那段接着放完。
    const resolvedRequest = isEdgeVoiceURI(settingsRef.current.voiceURI) ||
      !settingsRef.current.voiceURI
      ? resolvedEdgeVoiceURI(settingsRef.current.voiceURI)
      : settingsRef.current.voiceURI;
    const voiceChanged =
      activeVoiceRef.current !== "" &&
      resolvedRequest !== activeVoiceRef.current;

    if (engineRef.current === "edge") {
      const audio = audioRef.current;
      if (waitingForClipRef.current || voiceChanged) {
        playAt(current.bookId, current.chapterIndex, current.sentenceIndex, { tier: 0 });
        return;
      }
      if (audio && playingClipRef.current && audio.src === clipUrlRef.current && !audio.error && !audio.ended) {
        playingRef.current = true;
        setIsPlaying(true);
        setIsPaused(false);
        setIsBuffering(true);
        setError("");
        watchPlayback(audio);
        playAudio(audio, "播放被系统打断了，点一下继续");
        updatePositionState();
        const prepared = preparedLiveRef.current;
        if (prepared?.status?.ready) promoteLiveRef.current(prepared);
        return;
      }
      playAt(current.bookId, current.chapterIndex, current.sentenceIndex, { tier: 0 });
      return;
    }

    // 没有加载着的音频（停止过、暂停时跳到了别处）：从记下的位置重新起播，
    // 跟点播放键一样先试连续音频，顺便再给云端一次机会。
    const book = getBookRef.current(current.bookId);
    if (book) start(book.id, positionFor(book, current.chapterIndex, current.sentenceIndex));
  }, [pause, playAt, playAudio, start, updatePositionState, watchPlayback]);

  /**
   * 目标句还在已经加载的音频里（连续音频已经合成的部分、正在放的这段云端音频）就直接改时间轴。
   * 走 start/playAt 的话会按新起点重切文本，缓存键一变，音频明明在内存里也必然落空，
   * 每按一次都要等一轮云端合成。改成了返回 true。
   */
  const seekLoaded = useCallback(
    (book: Book, cursor: Cursor): boolean => {
      const audio = audioRef.current;
      if (!audio || audio.ended) return false;
      const live = liveRef.current;
      if (engineRef.current === "live" && live && live.bookId === book.id && !audio.error) {
        const sentence = live.plan.sentences[liveSentenceIndex(live.plan, cursor.chapterIndex, cursor.sentenceIndex)];
        const seconds = sentence ? liveTimeAtChar(live.status, sentence.start) : null;
        if (!sentence || seconds === null) return false;
        try {
          audio.currentTime = seconds;
        } catch {
          return false;
        }
        commitSpan(book, sentence.chapterIndex, sentence);
        updatePositionState();
        return true;
      }
      const clip = playingClipRef.current;
      if (
        engineRef.current === "edge" &&
        clip &&
        clip.bookId === book.id &&
        !waitingForClipRef.current &&
        audio.src === clipUrlRef.current
      ) {
        const span = spanForBookSentence(clip.segment, cursor.chapterIndex, cursor.sentenceIndex);
        if (!span) return false;
        try {
          audio.currentTime = timeAt(clip.clip.timeline, span.start);
        } catch {
          // 写不进去（元数据还没到位之类）就老实重开。
          return false;
        }
        commitSpan(book, span.chapterIndex, span);
        updatePositionState();
        return true;
      }
      return false;
    },
    [commitSpan, updatePositionState]
  );

  /**
   * 跳到某一句。keepPaused 时暂停着的不起播：在已加载的音频里就改时间轴，不在就卸下旧音频、
   * 只记位置，继续时从那里起播。
   */
  const jumpTo = useCallback(
    (book: Book, cursor: Cursor, keepPaused: boolean) => {
      cancelHandover();
      retargetSleepChapter(book, cursor.chapterIndex);
      if (seekLoaded(book, cursor)) {
        if (!keepPaused && !playingRef.current) toggle();
        return;
      }
      // 跳走之后旧位置的预取全都没用了。
      store.cancelPending();
      if (keepPaused && !playingRef.current) {
        tokenRef.current += 1;
        clearTimers();
        abortRef.current?.abort();
        abortRef.current = null;
        liveRef.current = null;
        playingClipRef.current = null;
        waitingForClipRef.current = false;
        engineRef.current = null;
        commitCursor(book, cursor);
        return;
      }
      start(book.id, positionFor(book, cursor.chapterIndex, cursor.sentenceIndex));
    },
    [cancelHandover, clearTimers, commitCursor, retargetSleepChapter, seekLoaded, start, store, toggle]
  );

  const skipSentences = useCallback(
    (delta: number) => {
      const current = locationRef.current;
      if (!current) return;
      const book = getBookRef.current(current.bookId);
      if (!book) return;
      const next = locationAfter(book, current.chapterIndex, current.sentenceIndex, delta);
      if (next) jumpTo(book, next, false);
    },
    [jumpTo]
  );

  /**
   * 前进、后退多少秒（屏幕上的时间，已经除过倍速）。在已经加载的音频里按真实时间轴跳，
   * 落到那一刻正在读的那一句的开头；跳出了音频才按字数估算。暂停着就只挪位置。
   */
  const skipSeconds = useCallback(
    (seconds: number) => {
      const at = locationRef.current;
      if (!at || !seconds) return;
      const book = getBookRef.current(at.bookId);
      if (!book) return;
      const rate = Math.max(settingsRef.current.speechRate, 0.1);
      const media = seconds * rate;
      const keepPaused = !playingRef.current;
      const audio = audioRef.current;
      let from: Cursor = at;
      let remaining = media;

      const live = liveRef.current;
      const clip = playingClipRef.current;
      if (engineRef.current === "live" && live && audio && live.bookId === book.id) {
        const target = audio.currentTime + media;
        const available = live.status.complete ? live.status.duration : live.status.duration - 1;
        if (target >= 0 && target < available) {
          const landing = liveLocationAt(live.plan, live.status, target);
          const current = liveSentenceIndex(live.plan, at.chapterIndex, at.sentenceIndex);
          let index = landing ? liveSentenceIndex(live.plan, landing.chapterIndex, landing.sentenceIndex) : -1;
          // 这一句本身比跳的秒数还长：至少往前挪到下一句。
          if (seconds > 0 && current >= 0 && index <= current) index = current + 1;
          const sentence = live.plan.sentences[index];
          if (sentence && liveTimeAtChar(live.status, sentence.start) !== null) {
            jumpTo(book, sentence, keepPaused);
            return;
          }
        }
        // 跳到会话开头之前：从会话第一句往回估。往后跳出已合成的部分就从当前句往后估。
        if (target < 0 && live.plan.sentences[0]) {
          from = live.plan.sentences[0];
          remaining = target;
        }
      } else if (
        engineRef.current === "edge" &&
        clip &&
        audio &&
        clip.bookId === book.id &&
        !waitingForClipRef.current &&
        audio.src === clipUrlRef.current
      ) {
        const { spans } = clip.segment;
        const { timeline } = clip.clip;
        const target = audio.currentTime + media;
        const lastStart = timeAt(timeline, spans[spans.length - 1].start);
        if (target >= 0 && target < lastStart) {
          let span = spanAt(spans, charIndexAt(timeline, target)) as BookSpeechSpan;
          const current = spanForBookSentence(clip.segment, at.chapterIndex, at.sentenceIndex);
          if (seconds > 0 && current && span.start <= current.start) {
            span = spans[spans.indexOf(current) + 1] ?? span;
          }
          jumpTo(book, span, keepPaused);
          return;
        }
        // 跳出了这段音频：从音频的头（尾）开始，剩下的秒数按字数估算接着挪。
        if (target < 0) {
          from = spans[0];
          remaining = target;
        } else {
          from = spans[spans.length - 1];
          remaining = target - lastStart;
        }
      }

      let target: Cursor = sentenceAfterSeconds(book.chapters, from.chapterIndex, from.sentenceIndex, remaining);
      const notAhead =
        target.chapterIndex < at.chapterIndex ||
        (target.chapterIndex === at.chapterIndex && target.sentenceIndex <= at.sentenceIndex);
      if (seconds > 0 && notAhead) {
        const next = nextBookSentence(book, at.chapterIndex, at.sentenceIndex + 1);
        // 已经是全书最后一句，往后没得跳了。
        if (!next) return;
        target = next;
      }
      jumpTo(book, target, keepPaused);
    },
    [jumpTo]
  );

  /** 锁屏进度条拖到第几秒（屏幕时钟），落到目录里这一章的哪一句。 */
  const seekToClock = useCallback(
    (seconds: number) => {
      const at = locationRef.current;
      const book = at ? getBookRef.current(at.bookId) : undefined;
      if (!at || !book) return;
      const rate = Math.max(settingsRef.current.speechRate, 0.1);
      const target = sentenceAtSeconds(listenFor(book, at.chapterIndex), seconds * rate);
      jumpTo(book, target, !playingRef.current);
    },
    [jumpTo, listenFor]
  );

  /** 按目录换章：续页并在前一章里，跳的是目录里的上一项、下一项。 */
  const changeChapter = useCallback(
    (delta: number) => {
      const current = locationRef.current;
      if (!current) return;
      const book = getBookRef.current(current.bookId);
      if (!book) return;
      const toc = tocIndexes(book.chapters);
      const index = toc.indexOf(tocIndexFor(toc, current.chapterIndex));
      const chapter = toc[Math.max(0, Math.min(toc.length - 1, index + delta))];
      const target = chapter === undefined ? null : nextBookSentence(book, chapter, 0);
      if (target) jumpTo(book, target, false);
    },
    [jumpTo]
  );

  const setSleepMode = useCallback(
    (mode: SleepMode) => {
      clearSleep();
      sleepModeRef.current = mode;
      setSleepModeState(mode);
      if (mode === "chapter") {
        // 从此刻所在的这一章（目录里的一项，续页算在内）读完时停；没在听就等开播时再定。
        const at = locationRef.current;
        const book = at ? getBookRef.current(at.bookId) : undefined;
        if (book && at) retargetSleepChapter(book, at.chapterIndex);
        return;
      }
      if (mode === "off") return;
      const ms = Number(mode) * 60_000;
      const deadline = Date.now() + ms;
      sleepDeadlineRef.current = deadline;
      setSleepDeadline(deadline);
      // 前台靠这个定时器；熄屏后定时器可能被节流，播放进度回调里也会检查是否到点。
      sleepTimerRef.current = setTimeout(() => {
        sleepTimerRef.current = null;
        if (playingRef.current) pauseForSleepRef.current(null);
        else clearSleep();
      }, ms + 50);
    },
    [clearSleep, retargetSleepChapter]
  );

  useEffect(
    () => () => {
      playingRef.current = false;
      liveRef.current = null;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (sleepTimerRef.current) clearTimeout(sleepTimerRef.current);
      if (startupTimerRef.current) clearTimeout(startupTimerRef.current);
      if (trackRef.current) clearInterval(trackRef.current);
      abortRef.current?.abort();
      handoverAbortRef.current?.abort();
      preparedLiveRef.current?.controller.abort();
      audioRef.current?.pause();
      if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current);

    },
    []
  );

  // 云端合成一律按原速，倍速交给 playbackRate，所以调速能在播放中立即生效。
  useEffect(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.defaultPlaybackRate = settings.speechRate;
      audio.playbackRate = settings.speechRate;
    }
    updatePositionState();
  }, [settings.speechRate, updatePositionState]);

  // 告诉系统这是个播放器会话，不是偶尔响一下的提示音；部分 Safari 版本
  // 会拿它来决定后台播放的优先级，属于零成本的顺手加固。
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const audioSession = (
      navigator as Navigator & { audioSession?: { type: string } }
    ).audioSession;
    if (audioSession) audioSession.type = "playback";
  }, []);

  // 锁屏和控制中心的那套控件。没有它，系统不把这个页面当成正在放音的播放器，
  // 切后台后一段读完就可能被冻结，再也接不上下一段。
  const actionsRef = useRef({ toggle, skipSeconds, seekToClock, changeChapter, stop });
  useEffect(() => {
    actionsRef.current = { toggle, skipSeconds, seekToClock, changeChapter, stop };
  }, [toggle, skipSeconds, seekToClock, changeChapter, stop]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
      return;
    }
    const session = navigator.mediaSession;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      // 被系统打断后 playingRef 已经同步成 false，这里按播放就是继续。
      ["play", () => {
        if (!playingRef.current) actionsRef.current.toggle();
      }],
      ["pause", () => {
        if (playingRef.current) actionsRef.current.toggle();
      }],
      ["stop", () => actionsRef.current.stop()],
      ["previoustrack", () => actionsRef.current.changeChapter(-1)],
      ["nexttrack", () => actionsRef.current.changeChapter(1)],
      ["seekbackward", (details) => actionsRef.current.skipSeconds(-(details.seekOffset ?? SKIP_SECONDS))],
      ["seekforward", (details) => actionsRef.current.skipSeconds(details.seekOffset ?? SKIP_SECONDS)],
      ["seekto", (details) => {
        if (typeof details.seekTime === "number") actionsRef.current.seekToClock(details.seekTime);
      }],
    ];
    for (const [action, handler] of handlers) {
      // 各家浏览器支持的动作不一样，不认的直接跳过。
      try {
        session.setActionHandler(action, handler);
      } catch {
        continue;
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          session.setActionHandler(action, null);
        } catch {
          continue;
        }
      }
      session.metadata = null;
      session.playbackState = "none";
    };
  }, []);

  const sessionBookId = location?.bookId ?? "";
  const sessionChapterIndex = location?.chapterIndex ?? -1;
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
      return;
    }
    const session = navigator.mediaSession;
    const book = getBookRef.current(sessionBookId);
    if (!book) {
      session.metadata = null;
      return;
    }
    session.metadata = new MediaMetadata({
      // 锁屏上显示的：章名（续页算前一章）、短书名。
      title: book.chapters.length
        ? chapterLabel(book.chapters, sessionChapterIndex)
        : displayTitle(book.title),
      artist: book.author || "墨听",
      album: displayTitle(book.title),
      artwork: [
        {
          src: book.coverDataUrl || "/icon-512.png",
          sizes: "512x512",
        },
      ],
    });
  }, [sessionBookId, sessionChapterIndex]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
      return;
    }
    navigator.mediaSession.playbackState = isPlaying
      ? "playing"
      : isPaused
        ? "paused"
        : "none";
  }, [isPlaying, isPaused]);

  return {
    voices,
    isPlaying,
    isPaused,
    isBuffering,
    location,
    currentSentenceId,
    error,
    sleepMode: sleepModeState,
    sleepDeadline,
    activeVoiceURI,
    pendingVoiceURI,
    voiceError,
    preparePlayback,
    start,
    toggle,
    stop,
    skipSentences,
    skipSeconds,
    changeChapter,
    setSleepMode,
    retryVoiceSwitch,
    prefetchVoices,
    cancelVoicePrefetch,
    prefetchStart,
    recentVoiceURIs,
  };
}
