"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flattenChapter, initialPosition, positionFor } from "../lib/content";
import { chapterLabel, displayTitle } from "../lib/display-title";
import {
  EDGE_VOICES,
  edgeVoiceName,
  isEdgeVoiceURI,
  normalizeVoiceURI,
  resolvedEdgeVoiceURI,
} from "../lib/edge-voices";
import { isAbortError, SpeechClipStore } from "../lib/speech-cache";
import {
  segmentFromBook,
  spanForBookSentence,
  nextBookSentence,
  type BookSpeechBlock,
  type BookSpeechSpan,
  type SpeechEngine,
} from "../lib/speech-segments";
import { SpeechClipError, type SpeechClip } from "../lib/speech-audio";
import { liveLocationAt, liveTimeFor, liveTimeAtChar, makeLivePlan, type LivePlan, type LiveStatus } from "../lib/live-speech";
import { charIndexAt, spanAt, timeAt } from "../lib/speech-timeline";
import type {
  Book,
  BookPosition,
  PlayerVoice,
  ReaderSettings,
  SpeechLocation,
  SpeechSpan,
} from "../lib/types";

export type SleepMode = "off" | "15" | "30" | "45" | "chapter";

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
  /** 真正在出声的那个音色，已折算成具体音色；云端退回系统朗读时这里是系统音色。 */
  activeVoiceURI: string;
  /** 用户刚点、正在准备的音色。空串表示没有正在进行的切换。 */
  pendingVoiceURI: string;
  /** 切换失败的原因。原音色会继续播，用户可以重试。 */
  voiceError: string;
  start: (bookId: string, position?: BookPosition) => void;
  toggle: () => void;
  stop: () => void;
  skipSentences: (delta: number) => void;
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

const NATURAL_VOICE_PATTERN =
  /natural|neural|premium|enhanced|online|siri|自然|在线/i;

function voiceScore(voice: SpeechSynthesisVoice): number {
  const lang = voice.lang.toLowerCase().replace(/_/g, "-");
  let score = 0;
  if (lang === "zh" || /^zh-(cn|hans|sg)/.test(lang)) score += 100;
  else if (lang.startsWith("zh")) score += 60;
  if (NATURAL_VOICE_PATTERN.test(voice.name)) score += 30;
  return score;
}

const CJK_CHARS_PER_SECOND = 5.2;
const LATIN_CHARS_PER_SECOND = 15;
const HIGHLIGHT_INTERVAL_MS = 100;
const LIVE_CLIENT_VERSION = "2026-10-07-continuous-v4";
function supportsNativeSpeechHls(): boolean {
  // Use Apple's native pipeline for EVENT audio and background playback.
  // Other browsers retain the established clip engine.
  return /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && /Safari/.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//.test(navigator.userAgent))
    ? !!document.createElement("audio").canPlayType("application/vnd.apple.mpegurl") : false;
}
function reusableAudio(ref: { current: HTMLAudioElement | null }): HTMLAudioElement {
  return ref.current ?? new Audio();
}
let liveClientId = "";
function reportLiveClient(stage: "prewarm" | "prewarm-failed" | "legacy-start", reason: string, hls: boolean) {
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

function estimateCharsPerSecond(text: string, rate: number): number {
  const cjk = text.match(/[㐀-鿿]/g)?.length ?? 0;
  const ratio = text.length ? cjk / text.length : 1;
  return (
    (ratio * CJK_CHARS_PER_SECOND + (1 - ratio) * LATIN_CHARS_PER_SECOND) *
    Math.max(rate, 0.1)
  );
}

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
  /** 起播、换音色、跳位置时给一段短的，出声快；接着往下读才换长批次。 */
  quick?: boolean;
  /** 交接用：音频从这一句对应的时间点开始放，而不是从整段开头。 */
  seekToSentence?: number;
}

export function useSpeechPlayer({
  getBook,
  settings: rawSettings,
  onProgress,
}: SpeechPlayerOptions): SpeechPlayerState {
  // 设置里可能还存着已经下架的音色或者以前选过的系统语音（旧版本、别的设备同步来的），
  // 一律按默认音色读。系统语音只在云端不可用时自动顶上。
  const settings = useMemo(() => {
    const voiceURI = normalizeVoiceURI(rawSettings.voiceURI);
    return voiceURI === rawSettings.voiceURI ? rawSettings : { ...rawSettings, voiceURI };
  }, [rawSettings]);
  const [systemVoices, setSystemVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [location, setLocation] = useState<SpeechLocation | null>(null);
  const [currentSentenceId, setCurrentSentenceId] = useState("");
  const [error, setError] = useState("");
  const [sleepModeState, setSleepModeState] = useState<SleepMode>("off");
  const [activeVoiceURI, setActiveVoiceURI] = useState("");
  const [pendingVoiceURI, setPendingVoiceURI] = useState("");
  const [voiceError, setVoiceError] = useState("");
  const [recentVoiceURIs, setRecentVoiceURIs] = useState<string[]>([]);

  const getBookRef = useRef(getBook);
  const settingsRef = useRef(settings);
  const onProgressRef = useRef(onProgress);
  const locationRef = useRef<SpeechLocation | null>(null);
  const playingRef = useRef(false);
  const tokenRef = useRef(0);
  const engineRef = useRef<SpeechEngine | "live" | "live-pending" | null>(null);
  const sleepModeRef = useRef<SleepMode>("off");
  const sleepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepAliveRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const trackRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const segmentCacheRef = useRef(new Map<string, BookSpeechBlock | null>());
  const blockedVoicesRef = useRef(new Set<string>());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const liveRef = useRef<{ bookId: string; plan: LivePlan; id: string; status: LiveStatus } | null>(null);
  const pendingLiveStartRef = useRef<{ bookId: string; position: BookPosition; key: string } | null>(null);
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
  const startRef = useRef<(bookId: string, position?: BookPosition) => void>(() => undefined);
  const resumeLiveRef = useRef<() => void>(() => undefined);
  const liveRecoveryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const edgeDownRef = useRef(false);
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
    onProgressRef.current = onProgress;
  }, [onProgress]);

  // 云端合成一律按原速，倍速交给 playbackRate，所以调速能在播放中立即生效。
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = settings.speechRate;
  }, [settings.speechRate]);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const update = () => {
      setSystemVoices(
        window.speechSynthesis
          .getVoices()
          .slice()
          .sort(
            (a, b) =>
              voiceScore(b) - voiceScore(a) || a.name.localeCompare(b.name)
          )
      );
    };
    update();
    window.speechSynthesis.addEventListener("voiceschanged", update);
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", update);
    };
  }, []);

  // 能选的只有云端音色；systemVoices 留着给云端断掉时自动顶上用。
  const voices: PlayerVoice[] = EDGE_VOICES;

  const clearTimers = useCallback(() => {
    if (liveRecoveryRef.current) {
      clearTimeout(liveRecoveryRef.current);
      liveRecoveryRef.current = null;
    }
    if (keepAliveRef.current) {
      clearInterval(keepAliveRef.current);
      keepAliveRef.current = null;
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
    setIsPlaying(false);
    setIsPaused(true);
    setIsBuffering(false);
    setError(message);
  }, []);

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

  const stop = useCallback(() => {
    tokenRef.current += 1;
    playingRef.current = false;
    engineRef.current = null;
    pendingLiveStartRef.current = null;
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
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    // 定时关闭是「这一次收听」的设置，停了就该归零，不然换本书还会在原来的时间点断掉。
    if (sleepTimerRef.current) {
      clearTimeout(sleepTimerRef.current);
      sleepTimerRef.current = null;
    }
    sleepModeRef.current = "off";
    setSleepModeState("off");
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
  }, [cancelHandover, clearTimers, releaseClip, silenceAudio, store]);

  /** 把「现在读到哪一句」落到状态和进度上。播放推进和段内快进共用这一条路。 */
  const commitSpan = useCallback(
    (book: Book, chapterIndex: number, span: SpeechSpan) => {
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
    },
    []
  );

  /** 章节分段的结果按（章, 引擎, 长短）缓存，滚动播放时不必每段重排一次全章。 */
  const segmentFor = useCallback(
    (
      book: Book,
      chapterIndex: number,
      sentenceIndex: number,
      engine: SpeechEngine,
      quick: boolean
    ): BookSpeechBlock | null => {
      const crossChapter = sleepModeRef.current !== "chapter";
      const key = `${book.id}:${engine}:${quick ? "q" : "l"}:${crossChapter}:${chapterIndex}:${sentenceIndex}`;
      const cached = segmentCacheRef.current.get(key);
      if (cached !== undefined) return cached;
      const segment = segmentFromBook(book, chapterIndex, sentenceIndex, engine, quick, crossChapter);
      // 缓存无上限会随着长书一直涨，超过这个数就整盘丢掉重来，代价只是重排一次。
      if (segmentCacheRef.current.size > 512) segmentCacheRef.current.clear();
      segmentCacheRef.current.set(key, segment);
      return segment;
    },
    []
  );

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
      const voiceURI = settingsRef.current.voiceURI;
      const useEdge =
        !edgeDownRef.current && (!voiceURI || isEdgeVoiceURI(voiceURI));
      const selectedEngine: SpeechEngine = useEdge ? "edge" : "system";
      const quick = options.quick ?? false;
      const segment = chapter
        ? segmentFor(book, chapterIndex, sentenceIndex, selectedEngine, quick)
        : null;

      if (!chapter || !segment) {
        const next = nextBookSentence(book, chapterIndex + 1, 0);
        if (next) {
          playAtRef.current?.(bookId, next.chapterIndex, next.sentenceIndex, { quick });
          return;
        }
        setError("当前章节没有可朗读内容");
        stop();
        return;
      }

      tokenRef.current += 1;
      const token = tokenRef.current;
      liveRef.current = null;
      pendingLiveStartRef.current = null;
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
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      // 已经退回系统朗读时要留着提示，否则读完一段就把「云端不可用」抹掉，
      // 用户永远不知道音色为什么变了。
      if (!edgeDownRef.current) setError("");

      const applySpan = (span: SpeechSpan) => {
        if (token !== tokenRef.current) return;
        commitSpan(book, (span as BookSpeechSpan).chapterIndex ?? chapterIndex, span);
      };

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
        const atChapterEnd = !next || next.chapterIndex !== last.chapterIndex;
        if (sleepModeRef.current === "chapter" && atChapterEnd) {
          stop();
          setSleepModeState("off");
          sleepModeRef.current = "off";
          return;
        }
        if (!next) { applySpan(last); stop(); return; }
        playAtRef.current?.(bookId, next.chapterIndex, next.sentenceIndex);
      };

      const startSystem = () => {
        if (
          typeof window === "undefined" ||
          !("speechSynthesis" in window) ||
          typeof SpeechSynthesisUtterance === "undefined"
        ) {
          setError("当前浏览器没有提供系统朗读能力");
          stop();
          return;
        }

        engineRef.current = "system";
        waitingForClipRef.current = false;
        setIsBuffering(false);
        // 系统朗读没有可跳的时间轴，段内快进这条路在这里必须断掉。
        playingClipRef.current = null;
        silenceAudio();
        releaseClip();
        const utterance = new SpeechSynthesisUtterance(segment.text);
        const usableVoices = systemVoices.filter(
          (voice) => !blockedVoicesRef.current.has(voice.voiceURI)
        );
        const selectedVoice =
          usableVoices.find(
            (voice) => voice.voiceURI === settingsRef.current.voiceURI
          ) ??
          usableVoices.find((voice) => voiceScore(voice) >= 100) ??
          usableVoices.find((voice) => voiceScore(voice) >= 60);
        if (selectedVoice) {
          utterance.voice = selectedVoice;
          utterance.lang = selectedVoice.lang;
        } else {
          utterance.lang = /[㐀-鿿]/.test(segment.text) ? "zh-CN" : "en-US";
        }
        utterance.rate = settingsRef.current.speechRate;
        utterance.pitch = 1;
        utterance.volume = 1;
        // 退回系统朗读时这里必须报真实音色，不能还显示用户选的那个云端音色。
        noteVoiceUsed(selectedVoice?.voiceURI ?? "");

        let boundarySeen = false;

        utterance.onboundary = (event) => {
          if (token !== tokenRef.current) return;
          boundarySeen = true;
          if (trackRef.current) {
            clearInterval(trackRef.current);
            trackRef.current = null;
          }
          applySpan(spanAt(segment.spans, event.charIndex));
        };

        utterance.onend = finishSegment;

        utterance.onerror = (event) => {
          if (token !== tokenRef.current) return;
          if (event.error === "canceled" || event.error === "interrupted") return;
          clearTimers();
          // 在线神经音色断网时会报这几种错，把它拉黑后用本地音色重试一次，避免离线时完全不能听。
          const recoverable =
            event.error === "network" ||
            event.error === "synthesis-failed" ||
            event.error === "synthesis-unavailable";
          if (recoverable && selectedVoice && !selectedVoice.localService) {
            blockedVoicesRef.current.add(selectedVoice.voiceURI);
            playAtRef.current?.(bookId, chapterIndex, sentenceIndex, { quick });
            return;
          }
          setError("系统朗读被中断，请重新播放");
          stop();
        };

        window.speechSynthesis.speak(utterance);

        // Chrome 播放单条 utterance 约 15 秒后会静默截断，定期 pause/resume 可以让它继续念完整段。
        keepAliveRef.current = setInterval(() => {
          if (token !== tokenRef.current) return;
          // iOS 上 synth.paused 不可靠，只认我们自己记的状态，否则会把用户的暂停顶回去。
          if (!playingRef.current) return;
          const synth = window.speechSynthesis;
          if (synth.speaking && !synth.paused) {
            synth.pause();
            synth.resume();
          }
        }, 10000);

        // iOS Safari 不派发 boundary 事件，用朗读速度估算高亮位置，等真实事件到达后立刻交还控制权。
        const charsPerSecond = estimateCharsPerSecond(
          segment.text,
          utterance.rate
        );
        let elapsed = 0;
        trackRef.current = setInterval(() => {
          if (token !== tokenRef.current || boundarySeen) return;
          if (!playingRef.current || window.speechSynthesis.paused) return;
          elapsed += HIGHLIGHT_INTERVAL_MS;
          applySpan(spanAt(segment.spans, (elapsed / 1000) * charsPerSecond));
        }, HIGHLIGHT_INTERVAL_MS);
      };

      const startEdge = () => {
        engineRef.current = "edge";
        const voiceName = edgeVoiceName(settingsRef.current.voiceURI);

        const prefetchNext = () => {
          const last = segment.spans[segment.spans.length - 1];
          const continuation = nextBookSentence(book, last.chapterIndex, last.sentenceIndex + 1);
          if (!continuation || (sleepModeRef.current === "chapter" && continuation.chapterIndex !== chapterIndex)) return;

          // 短首段之后要预取的是「长批次的精确续点」，不能预取另一个短块，
          // 否则首段读完还要再等一次网络。
          const next = segmentFor(book, continuation.chapterIndex, continuation.sentenceIndex, "edge", false);
          if (next) store.prefetch(next.text, voiceName);
        };

        const beginClip = (clip: SpeechClip) => {
          const audio = audioRef.current ?? new Audio();
          audioRef.current = audio;
          audio.loop = false;
          audio.onended = finishSegment;
          audio.onerror = () => {
            if (token !== tokenRef.current) return;
            holdForResume("这一段没能播出来，点一下继续");
          };
          const previous = clipUrlRef.current;
          const url = URL.createObjectURL(clip.audio);
          clipUrlRef.current = url;
          audio.src = url;
          if (previous) URL.revokeObjectURL(previous);
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
          setIsBuffering(false);
          playingClipRef.current = { bookId, chapterIndex, segment, clip };
          noteVoiceUsed(resolvedEdgeVoiceURI(settingsRef.current.voiceURI));
          setVoiceError("");
          void audio.play().catch(() => {
            if (token !== tokenRef.current) return;
            holdForResume("播放被系统打断了，点一下继续");
          });

          trackRef.current = setInterval(() => {
            if (token !== tokenRef.current || audio.paused) return;
            applySpan(
              spanAt(segment.spans, charIndexAt(clip.timeline, audio.currentTime))
            );
          }, HIGHLIGHT_INTERVAL_MS);

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
        waitingAudio.loop = true;
        waitingAudio.src = silentClipUrl();
        waitingForClipRef.current = true;
        setIsBuffering(true);
        void waitingAudio.play().catch(() => undefined);

        const controller = new AbortController();
        abortRef.current = controller;

        store
          .request(segment.text, voiceName, {
            priority: true,
            signal: controller.signal,
          })
          .then((clip) => {
            if (token !== tokenRef.current || !playingRef.current) return;
            beginClip(clip);
          })
          .catch((reason: unknown) => {
            if (token !== tokenRef.current || !playingRef.current) return;
            if (isAbortError(reason)) return;
            // 只有服务真的不可用才拉闸退回系统朗读；单段合成失败下一段还要再试云端，
            // 否则一句超长文本就能让后面整本书都变成机器音。
            const serviceDown =
              !(reason instanceof SpeechClipError) || reason.serviceDown;
            edgeDownRef.current = true;
            waitingForClipRef.current = false;
            setIsBuffering(false);
            setError(
              serviceDown
                ? "云端语音暂不可用，已切换到系统朗读"
                : "这一段云端读不了，已切换到系统朗读"
            );
            // 云端批次远长于系统 utterance，必须按系统语音的小块重新定位，
            // 不能把几千字直接塞进 SpeechSynthesisUtterance。
            playAtRef.current?.(
              bookId,
              chapterIndex,
              startSpan.sentenceIndex,
              { quick: true }
            );
          });
      };

      playingRef.current = true;
      setIsPlaying(true);
      setIsPaused(false);

      if (useEdge) startEdge();
      else startSystem();
    },
    [
      cancelHandover,
      clearTimers,
      commitSpan,
      holdForResume,
      noteVoiceUsed,
      releaseClip,
      segmentFor,
      silenceAudio,
      stop,
      store,
      systemVoices,
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

      const useEdge = !edgeDownRef.current && (!voiceURI || isEdgeVoiceURI(voiceURI));
      // 系统语音本地就能出声，没有可预合成的东西，直接重开这一段最快。
      if (!useEdge) {
        handoverPendingRef.current = false;
        setPendingVoiceURI("");
        playAt(at.bookId, at.chapterIndex, at.sentenceIndex, { quick: true });
        return;
      }

      const book = getBookRef.current(at.bookId);
      if (book && (engineRef.current === "live" || engineRef.current === "live-pending")) {
        startRef.current(book.id, positionFor(book, at.chapterIndex, at.sentenceIndex));
        return;
      }
      const chapter = book?.chapters[at.chapterIndex];
      let segment = chapter
        ? segmentFor(book!, at.chapterIndex, at.sentenceIndex, "edge", true)
        : null;
      if (!chapter || !segment) {
        handoverPendingRef.current = false;
        setPendingVoiceURI("");
        playAt(at.bookId, at.chapterIndex, at.sentenceIndex, { quick: true });
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
        const prepared = segmentFor(book!, at.chapterIndex, anchor.sentenceIndex, "edge", true);
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
              quick: true,
              seekToSentence: now.sentenceIndex,
            });
          } else {
            playAt(now.bookId, now.chapterIndex, now.sentenceIndex, {
              quick: true,
            });
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
      const segment = segmentFor(book!, at.chapterIndex, at.sentenceIndex, "edge", true);
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
      // 云端已经不可用（退回了系统朗读），备了也用不上。
      if (edgeDownRef.current) {
        reportLiveClient("prewarm-failed", "edge-unavailable", false);
        return;
      }
      const voiceURI = settingsRef.current.voiceURI;
      if (voiceURI && !isEdgeVoiceURI(voiceURI)) {
        reportLiveClient("prewarm-failed", "unsupported-voice", false);
        return;
      }
      const voiceName = edgeVoiceName(voiceURI);
      const supportsHls = typeof document !== "undefined" &&
        sleepModeRef.current !== "chapter" && supportsNativeSpeechHls();
      reportLiveClient("prewarm", supportsHls ? "native-hls" : "no-native-hls", supportsHls);
      if (supportsHls) {
        const key = `${book.id}:${position.chapterIndex}:${position.sentenceIndex}:${voiceName}`;
        if (preparedLiveRef.current?.key === key && !(forPlayback && preparedLiveRef.current.failed)) return;
        preparedLiveRef.current?.controller.abort();
        const plan = makeLivePlan(book, position);
        if (plan.sentences.length) {
          const prepared = { key, plan, voice: voiceName, controller: new AbortController() } as NonNullable<typeof preparedLiveRef.current>;
          preparedLiveRef.current = prepared;
          void (async () => {
            try {
              const response = await fetch("/api/sync/live/session", {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ text: plan.text, voice: voiceName }),
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
                  if (!playingRef.current || engineRef.current !== "edge" || sleepModeRef.current === "chapter" ||
                      prepared.voice !== edgeVoiceName(settingsRef.current.voiceURI)) return;
                  // The short opening may already be ahead of this first HLS window; wait for more audio.
                }
                await new Promise<void>(resolve => setTimeout(resolve, attempt < 15 ? 1000 : 2000));
              }
              prepared.failed = true;
              throw new Error("连续音频准备超时");
            } catch (error) {
              if (!prepared.controller.signal.aborted) {
                prepared.failed = true;
                reportLiveClient("prewarm-failed", error instanceof Error ? error.message : "request-failed", true);
                const pending = pendingLiveStartRef.current;
                if (pending?.key === key && playingRef.current) {
                  pendingLiveStartRef.current = null;
                  playAtRef.current?.(pending.bookId, pending.position.chapterIndex, pending.position.sentenceIndex, { quick: true });
                }
              }
              // Offline and unauthenticated readers retain the existing TTS player.
            }
          })();
        } else reportLiveClient("prewarm-failed", "no-sentences", true);
      }
      // Native playback has one continuous source from the opening. A second short clip
      // would force an audible source replacement several seconds into listening.
      if (supportsHls) return;
      // 这里收整本书而不是 bookId：调用方（播放页）手里本来就是这本书的整本，不用再查一次。
      const chapter = book.chapters[position.chapterIndex];
      if (!chapter) return;
      // 必须和 playAt 起播时算出来的那一段完全一致，否则是另一个缓存键，白备。
      const segment = segmentFor(book, position.chapterIndex, position.sentenceIndex, "edge", true);
      if (!segment) return;
      if (store.has(segment.text, voiceName)) return;
      store.prefetch(segment.text, voiceName);
    },
    [segmentFor, store]
  );

  const startLive = useCallback((book: Book, prepared: NonNullable<typeof preparedLiveRef.current>, position?: BookPosition, offset = 0): boolean => {
    if (prepared.failed || !prepared.id || !prepared.url || !prepared.status?.ready || sleepModeRef.current === "chapter") return false;
    const first = position
      ? prepared.plan.sentences.find(sentence => sentence.chapterIndex === position.chapterIndex && sentence.sentenceIndex === position.sentenceIndex)
      : prepared.plan.sentences[0];
    if (!first) return false;
    const seekTime = liveTimeAtChar(prepared.status, Math.min(first.end - 1, first.start + offset));
    if (seekTime === null || (!prepared.status.complete && prepared.status.duration - seekTime < 24)) return false;
    tokenRef.current++;
    clearTimers();
    abortRef.current?.abort();
    cancelHandover();
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    releaseClip();
    playingClipRef.current = null;
    // Reuse the element activated by the user's play gesture; a fresh element loses that grant on iOS.
    pendingLiveStartRef.current = null;
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
    const nativePlaylist = prepared.url.includes(".m3u8");
    const sourceAt = (time: number) => nativePlaylist ? `${prepared.url}${prepared.url!.includes("?") ? "&" : "?"}start=${time.toFixed(6)}` : prepared.url!;
    audio.src = sourceAt(seekTime);
    audio.playbackRate = settingsRef.current.speechRate;
    audioRef.current = audio;
    const id = prepared.id;
    const live = { bookId: book.id, plan: prepared.plan, id, status: prepared.status };
    let started = false;
    let awaitingSeek = seekTime > 0 || !!position;
    let lastTime = seekTime;
    let lastAdvance = Date.now();
    let recoveries = 0;
    let resumeTime = seekTime;
    liveRef.current = live;
    engineRef.current = "live";
    playingRef.current = true;
    waitingForClipRef.current = false;
    setIsPlaying(true);
    setIsPaused(false);
    setIsBuffering(true);
    setError("");
    noteVoiceUsed(resolvedEdgeVoiceURI(settingsRef.current.voiceURI));
    commitSpan(book, first.chapterIndex, {
      sentenceId: first.sentenceId, sentenceIndex: first.sentenceIndex,
      start: first.start, end: first.end,
    });
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
      if (at) commitSpan(book, at.chapterIndex, {
        sentenceId: at.sentenceId, sentenceIndex: at.sentenceIndex,
        start: at.start, end: at.end,
      });
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
      if (at?.bookId === book.id) playAtRef.current?.(book.id, at.chapterIndex, at.sentenceIndex, { quick: true });
    };
    const applySeek = () => {
      if (liveRef.current !== live) return;
      // Safari can expose metadata before an EVENT stream has a seekable range.
      // EXT-X-START selects the right segment without stranding it at readyState=1.
      if (nativePlaylist) return;
      try { audio.currentTime = resumeTime; } catch { /* Retry when metadata arrives. */ }
    };
    if (seekTime > 0) {
      applySeek();
      audio.addEventListener("loadedmetadata", applySeek, { once: true });
    }
    audio.ontimeupdate = update;
    const resume = () => {
      if (liveRef.current !== live || !playingRef.current || !audio.paused || liveRecoveryRef.current) return;
      void audio.play().catch((reason: unknown) => {
        if (liveRef.current !== live || !playingRef.current) return;
        if (reason instanceof DOMException && reason.name === "NotAllowedError") {
          setError("系统暂时中断播放，可从锁屏播放键或回到应用继续");
        }
      });
    };
    resumeLiveRef.current = resume;
    const reconnect = (reason: string) => {
      if (liveRef.current !== live || !playingRef.current || liveRecoveryRef.current) return;
      update();
      resumeTime = Math.max(resumeTime, audio.currentTime);
      setIsBuffering(true);
      reportLiveClient("legacy-start", `native-retry:${reason}`, true);
      liveRecoveryRef.current = setTimeout(() => {
        liveRecoveryRef.current = null;
        if (liveRef.current !== live || !playingRef.current) return;
        awaitingSeek = resumeTime > 0;
        started = false;
        lastAdvance = Date.now();
        audio.src = sourceAt(resumeTime);
        if (!nativePlaylist && resumeTime > 0) audio.addEventListener("loadedmetadata", applySeek, { once: true });
        void audio.play().catch(() => { /* OS interruptions retain the session and playback intent. */ });
      }, Math.min(1000 * 2 ** recoveries++, 15_000));
    };
    audio.onplay = () => reportLiveEvent(id, audio, "play");
    audio.onpause = () => {
      lastAdvance = Date.now(); reportLiveEvent(id, audio, "pause");
      if (playingRef.current && !audio.ended && !audio.error) resume();
    };
    audio.onstalled = () => reportLiveEvent(id, audio, "stalled");
    audio.onplaying = () => {
      started = true;
      lastAdvance = Date.now();
      recoveries = 0;
      if (liveRef.current === live) { setIsBuffering(false); setError(""); }
      reportLiveEvent(id, audio, "playing");
    };
    audio.onwaiting = () => {
      if (liveRef.current === live) { setIsBuffering(true); void refresh(); }
      reportLiveEvent(id, audio, "waiting");
    };
    audio.onerror = () => {
      reportLiveEvent(id, audio, "error");
      if (audio.error?.code === 4) fallback("unsupported-format");
      else reconnect("media-error");
    };
    audio.onended = () => {
      reportLiveEvent(id, audio, "ended");
      if (liveRef.current !== live || !playingRef.current) return;
      update();
      if (!live.status.complete || audio.currentTime < live.status.duration - 1) { reconnect("early-end"); return; }
      const last = live.plan.sentences.at(-1)!;
      const next = nextBookSentence(book, last.chapterIndex, last.sentenceIndex + 1);
      if (next) startRef.current(book.id, positionFor(book, next.chapterIndex, next.sentenceIndex));
      else stop();
    };
    trackRef.current = setInterval(() => {
      if (liveRef.current !== live || document.visibilityState !== "visible") return;
      update();
      void refresh();
      if (playingRef.current && audio.paused && !audio.ended) resume();
      if (playingRef.current && Date.now() - lastAdvance > 45_000) reconnect("stalled");
    }, 3000);
    // Called in the same user gesture as start(): Safari can activate native playback.
    void audio.play().catch(() => {
      if (liveRef.current === live) holdForResume("播放被系统拦下，点一下继续");
    });
    setTimeout(() => {
      if (liveRef.current !== live || !playingRef.current || started || document.visibilityState !== "visible") return;
      reportLiveEvent(id, audio, "error");
      // Retry a stalled native startup without discarding its durable session.
      reconnect("startup-timeout");
    }, 20000);
    return true;
  }, [cancelHandover, clearTimers, commitSpan, holdForResume, noteVoiceUsed, releaseClip, stop]);

  useEffect(() => {
    promoteLiveRef.current = (prepared) => {
      const pending = pendingLiveStartRef.current;
      if (pending?.key === prepared.key && preparedLiveRef.current === prepared && playingRef.current && engineRef.current === "live-pending") {
        const book = getBookRef.current(pending.bookId);
        if (book) startLive(book, prepared, pending.position);
        return;
      }
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

  useEffect(() => {
    const onVisibility = () => {
      const live = liveRef.current;
      const audio = audioRef.current;
      if (live && audio) reportLiveEvent(live.id, audio, "visibility");
      if (live && playingRef.current && document.visibilityState === "visible") resumeLiveRef.current();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const start = useCallback(
    (bookId: string, position?: BookPosition) => {
      const book = getBookRef.current(bookId);
      if (!book) return;
      // 用户主动开播时再给云端一次机会，之前的失败可能只是临时断网。
      edgeDownRef.current = false;
      // 拉黑的系统音色多半也是那次断网连累的，一起放出来重试。
      blockedVoicesRef.current.clear();
      cancelHandover();
      setVoiceError("");
      const nextPosition =
        position ?? book.listeningPosition ?? initialPosition(book);
      // Starting from the home card or reader must prepare HLS too, even without visiting the player page.
      prefetchStart(book, nextPosition, true);
      const prepared = preparedLiveRef.current;
      const key = `${book.id}:${nextPosition.chapterIndex}:${nextPosition.sentenceIndex}:${edgeVoiceName(settingsRef.current.voiceURI)}`;
      if (prepared?.key === key && startLive(book, prepared)) return;
      if (prepared?.key === key && !prepared.failed && sleepModeRef.current !== "chapter") {
        tokenRef.current++;
        clearTimers();
        abortRef.current?.abort();
        liveRef.current = null;
        playingClipRef.current = null;
        pendingLiveStartRef.current = { bookId, position: nextPosition, key };
        engineRef.current = "live-pending";
        playingRef.current = true;
        waitingForClipRef.current = true;
        setIsPlaying(true);
        setIsPaused(false);
        setIsBuffering(true);
        setError("");
        const sentence = flattenChapter(book.chapters[nextPosition.chapterIndex])[nextPosition.sentenceIndex];
        if (sentence) commitSpan(book, nextPosition.chapterIndex, {
          sentenceIndex: nextPosition.sentenceIndex, sentenceId: sentence.id, start: 0, end: sentence.text.length,
        });
        // Activate this one element in the user's gesture. The actual native stream will
        // reuse it as soon as the first 24 seconds have been generated by the Queue.
        const audio = reusableAudio(audioRef);
        audioRef.current = audio;
        audio.onended = null; audio.onerror = null; audio.ontimeupdate = null;
        audio.onplay = null; audio.onpause = null; audio.onplaying = null;
        audio.onwaiting = null; audio.onstalled = null;
        audio.loop = true;
        audio.src = silentClipUrl();
        releaseClip();
        void audio.play().catch(() => { /* Activation will be checked by native playback. */ });
        return;
      }
      reportLiveClient("legacy-start", !prepared ? "no-prewarm" : prepared.key !== key ? "position-changed" :
        !prepared.id ? "session-pending" : !prepared.status?.ready ? `buffer-${Math.round(prepared.status?.duration ?? 0)}` : "not-playable",
        !!document.createElement("audio").canPlayType("application/vnd.apple.mpegurl"));
      playAt(bookId, nextPosition.chapterIndex, nextPosition.sentenceIndex, {
        quick: true,
      });
    },
    [cancelHandover, clearTimers, commitSpan, playAt, prefetchStart, releaseClip, startLive]
  );

  useEffect(() => { startRef.current = start; }, [start]);

  const toggle = useCallback(() => {
    const current = locationRef.current;
    if (!current) return;

    if (engineRef.current === "live" || engineRef.current === "live-pending") {
      const audio = audioRef.current;
      if (!audio) return;
      if (playingRef.current) {
        playingRef.current = false;
        if (liveRecoveryRef.current) { clearTimeout(liveRecoveryRef.current); liveRecoveryRef.current = null; }
        audio.pause();
        setIsPlaying(false);
        setIsPaused(true);
        setIsBuffering(false);
      } else {
        if (activeVoiceRef.current && activeVoiceRef.current !== resolvedEdgeVoiceURI(settingsRef.current.voiceURI)) {
          const book = getBookRef.current(current.bookId);
          if (book) startRef.current(book.id, positionFor(book, current.chapterIndex, current.sentenceIndex));
          return;
        }
        if (audio.error || audio.ended) {
          const book = getBookRef.current(current.bookId);
          const prepared = preparedLiveRef.current;
          if (book && prepared && startLive(book, prepared, positionFor(book, current.chapterIndex, current.sentenceIndex))) return;
          if (book) startRef.current(book.id, positionFor(book, current.chapterIndex, current.sentenceIndex));
          return;
        }
        playingRef.current = true;
        setIsPlaying(true);
        setIsPaused(false);
        if (engineRef.current === "live-pending") {
          const prepared = preparedLiveRef.current;
          setIsBuffering(true);
          if (prepared?.failed) { startRef.current(current.bookId, positionFor(getBookRef.current(current.bookId)!, current.chapterIndex, current.sentenceIndex)); return; }
          if (prepared?.status?.ready) { promoteLiveRef.current(prepared); return; }
        }
        void audio.play().catch(() => holdForResume("播放被系统拦下，点一下继续"));
      }
      return;
    }

    // 暂停期间换过音色：恢复时不能把旧音色那段接着放完。
    const resolvedRequest = isEdgeVoiceURI(settingsRef.current.voiceURI) ||
      !settingsRef.current.voiceURI
      ? resolvedEdgeVoiceURI(settingsRef.current.voiceURI)
      : settingsRef.current.voiceURI;
    const voiceChanged =
      !playingRef.current &&
      activeVoiceRef.current !== "" &&
      resolvedRequest !== activeVoiceRef.current;

    if (engineRef.current === "edge") {
      const audio = audioRef.current;
      if (playingRef.current) {
        abortRef.current?.abort();
        cancelHandover();
        audio?.pause();
        playingRef.current = false;
        setIsPlaying(false);
        setIsPaused(true);
        setIsBuffering(false);
        return;
      }
      if (waitingForClipRef.current || voiceChanged) {
        playAt(current.bookId, current.chapterIndex, current.sentenceIndex, {
          quick: true,
        });
        return;
      }
      if (audio?.src && !audio.ended) {
        playingRef.current = true;
        setIsPlaying(true);
        setIsPaused(false);
        void audio.play().catch(() => undefined);
        const prepared = preparedLiveRef.current;
        if (prepared?.status?.ready) promoteLiveRef.current(prepared);
        return;
      }
      playAt(current.bookId, current.chapterIndex, current.sentenceIndex, {
        quick: true,
      });
      return;
    }

    if (engineRef.current === "system") {
      if (voiceChanged) {
        playAt(current.bookId, current.chapterIndex, current.sentenceIndex, {
          quick: true,
        });
        return;
      }
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
        playingRef.current = true;
        setIsPlaying(true);
        setIsPaused(false);
      } else if (window.speechSynthesis.speaking) {
        window.speechSynthesis.pause();
        // 这行不能漏：保活定时器和 finishSegment 都拿 playingRef 当闸门，
        // 留着 true 的话 iOS 上十秒内会自己 resume 回去，或者偷偷跳到下一段。
        playingRef.current = false;
        setIsPaused(true);
        setIsPlaying(false);
      } else {
        playAt(current.bookId, current.chapterIndex, current.sentenceIndex, {
          quick: true,
        });
      }
      return;
    }

    // 已停止，重新起播；顺便给云端一次机会，之前的失败可能只是临时断网。
    edgeDownRef.current = false;
    playAt(current.bookId, current.chapterIndex, current.sentenceIndex, {
      quick: true,
    });
  }, [cancelHandover, holdForResume, playAt, startLive]);

  const skipSentences = useCallback(
    (delta: number) => {
      const current = locationRef.current;
      if (!current) return;
      const book = getBookRef.current(current.bookId);
      if (!book) return;
      const next = locationAfter(
        book,
        current.chapterIndex,
        current.sentenceIndex,
        delta
      );
      if (!next) return;
      cancelHandover();
      if (engineRef.current === "live" && liveRef.current && audioRef.current && playingRef.current) {
        const seconds = liveTimeFor(liveRef.current.plan, liveRef.current.status, next.chapterIndex, next.sentenceIndex);
        if (seconds !== null) {
          audioRef.current.currentTime = seconds;
          const sentence = liveRef.current.plan.sentences.find(part =>
            part.chapterIndex === next.chapterIndex && part.sentenceIndex === next.sentenceIndex);
          if (sentence) commitSpan(book, next.chapterIndex, {
            sentenceId: sentence.sentenceId, sentenceIndex: sentence.sentenceIndex,
            start: sentence.start, end: sentence.end,
          });
          return;
        }
      }

      // 目标句还在正在播的这段音频里就直接跳时间轴。
      //
      // 走 playAt 的话，它会按新起点重新切一段短文本去合成——文本变了缓存键就变了，
      // 哪怕音频早就在内存里也必然落空，于是每按一次快进都要等一轮云端合成。
      // 实测稳态播的是 2000 字 / 52 句的长批次，±2 句几乎都落在段内，白等 3~4 秒。
      // 暂停时不走这条路：那时按快进本来就该顺带起播，交给 playAt 更省事。
      const playing = playingClipRef.current;
      const audio = audioRef.current;
      if (
        playing &&
        audio &&
        playingRef.current &&
        engineRef.current === "edge" &&
        !waitingForClipRef.current &&
        playing.bookId === book.id
      ) {
        const span = spanForBookSentence(playing.segment, next.chapterIndex, next.sentenceIndex);
        if (span) {
          try {
            audio.currentTime = timeAt(playing.clip.timeline, span.start);
            commitSpan(book, next.chapterIndex, span);
            return;
          } catch {
            // 写不进去（元数据还没到位之类）就老实重开这一段。
          }
        }
      }

      start(book.id, positionFor(book, next.chapterIndex, next.sentenceIndex));
    },
    [cancelHandover, commitSpan, start]
  );

  const changeChapter = useCallback(
    (delta: number) => {
      const current = locationRef.current;
      if (!current) return;
      const book = getBookRef.current(current.bookId);
      if (!book) return;
      const chapterIndex = Math.max(
        0,
        Math.min(book.chapters.length - 1, current.chapterIndex + delta)
      );
      cancelHandover();
      if (engineRef.current === "live" && liveRef.current && audioRef.current && playingRef.current) {
        const target = nextBookSentence(book, chapterIndex, 0);
        const seconds = target && liveTimeFor(liveRef.current.plan, liveRef.current.status, target.chapterIndex, target.sentenceIndex);
        if (target && seconds !== null) {
          audioRef.current.currentTime = seconds!;
          const sentence = liveRef.current.plan.sentences.find(part => part.chapterIndex === target.chapterIndex && part.sentenceIndex === target.sentenceIndex)!;
          commitSpan(book, target.chapterIndex, { ...sentence, start: sentence.start, end: sentence.end });
          return;
        }
      }
      // 跳章之后旧位置的预取全都没用了。
      store.cancelPending();
      start(book.id, positionFor(book, chapterIndex, 0));
    },
    [cancelHandover, commitSpan, start, store]
  );

  const setSleepMode = useCallback(
    (mode: SleepMode) => {
      if (sleepTimerRef.current) {
        clearTimeout(sleepTimerRef.current);
        sleepTimerRef.current = null;
      }
      sleepModeRef.current = mode;
      setSleepModeState(mode);
      if (mode === "chapter" && playingRef.current && locationRef.current) {
        const at = locationRef.current;
        playAt(at.bookId, at.chapterIndex, at.sentenceIndex, { quick: true });
      }
      if (mode === "15" || mode === "30" || mode === "45") {
        sleepTimerRef.current = setTimeout(() => {
          stop();
          sleepModeRef.current = "off";
          setSleepModeState("off");
        }, Number(mode) * 60 * 1000);
      }
    },
    [playAt, stop]
  );

  useEffect(
    () => () => {
      playingRef.current = false;
      liveRef.current = null;
      pendingLiveStartRef.current = null;
      if (liveRecoveryRef.current) clearTimeout(liveRecoveryRef.current);
      if (sleepTimerRef.current) clearTimeout(sleepTimerRef.current);
      if (keepAliveRef.current) clearInterval(keepAliveRef.current);
      if (trackRef.current) clearInterval(trackRef.current);
      abortRef.current?.abort();
      handoverAbortRef.current?.abort();
      preparedLiveRef.current?.controller.abort();
      audioRef.current?.pause();
      if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current);
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    },
    []
  );

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
  const actionsRef = useRef({ toggle, skipSentences, changeChapter, stop });
  useEffect(() => {
    actionsRef.current = { toggle, skipSentences, changeChapter, stop };
  }, [toggle, skipSentences, changeChapter, stop]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
      return;
    }
    const session = navigator.mediaSession;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => {
        if (!playingRef.current) actionsRef.current.toggle();
      }],
      ["pause", () => {
        if (playingRef.current) actionsRef.current.toggle();
      }],
      ["stop", () => actionsRef.current.stop()],
      ["previoustrack", () => actionsRef.current.changeChapter(-1)],
      ["nexttrack", () => actionsRef.current.changeChapter(1)],
      ["seekbackward", () => actionsRef.current.skipSentences(-2)],
      ["seekforward", () => actionsRef.current.skipSentences(2)],
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
    activeVoiceURI,
    pendingVoiceURI,
    voiceError,
    start,
    toggle,
    stop,
    skipSentences,
    changeChapter,
    setSleepMode,
    retryVoiceSwitch,
    prefetchVoices,
    cancelVoicePrefetch,
    prefetchStart,
    recentVoiceURIs,
  };
}
