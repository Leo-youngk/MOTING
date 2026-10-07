"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { initialPosition, positionFor } from "../lib/content";
import {
  chapterLabel,
  displayTitle,
  tocIndexes,
  tocIndexFor,
  tocRange,
} from "../lib/display-title";
import {
  EDGE_VOICES,
  edgeVoiceName,
  normalizeVoiceURI,
  resolvedEdgeVoiceURI,
} from "../lib/edge-voices";
import {
  chapterDuration,
  listenChapter,
  sentenceAtSeconds,
  sentenceSeconds,
  type ListenChapter,
} from "../lib/listen-clock";
import { SpeechClipError, type SpeechClip } from "../lib/speech-audio";
import { isAbortError, SpeechClipStore } from "../lib/speech-cache";
import { createSpeechPersistence } from "../lib/speech-persist";
import {
  cursorAfterSeconds,
  cursorAt,
  gridSegmentAt,
  nextTier,
  ordinalOf,
  spanForSentence,
  speechIndexFor,
  speechReplacer,
  speechSegment,
  systemSegment,
  type SpeechCursor,
  type SpeechSegment,
  type SpeechTier,
} from "../lib/speech-segments";
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

/** 快进快退一下跳多少秒（按屏幕上的时钟，也就是已经除过倍速的时间）。 */
export const SKIP_SECONDS = 15;

export interface SpeechDownload {
  bookId: string;
  total: number;
  done: number;
  failed: number;
  running: boolean;
}

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
  /** 定时关闭的到点时刻（毫秒时间戳）；不是按分钟定时的时候为 null。 */
  sleepDeadline: number | null;
  /** 真正在出声的那个音色；云端暂时不可用、退回系统朗读时这里是系统音色。 */
  activeVoiceURI: string;
  /** 云端暂时不可用，正在用系统声音顶着，过一阵会自动试着换回来。 */
  usingFallback: boolean;
  download: SpeechDownload | null;
  start: (bookId: string, position?: BookPosition) => void;
  toggle: () => void;
  stop: () => void;
  /** 往前（正数）或往后跳多少秒，按屏幕时钟算。 */
  skipSeconds: (seconds: number) => void;
  changeChapter: (delta: number) => void;
  setSleepMode: (mode: SleepMode) => void;
  /** 进播放页时把首段提前备好，点下去就不用等合成。 */
  prefetchStart: (book: Book, position: BookPosition) => void;
  /** 把当前位置往后几章的音频合成好存在本机，没网也能听。 */
  downloadAhead: (bookId: string, chapters: number) => void;
  cancelDownload: () => void;
}

const NATURAL_VOICE_PATTERN =
  /natural|neural|premium|enhanced|online|siri|自然|在线/i;
/**
 * 各平台公认好听的中文系统音色（取自 Readium Speech 的推荐表）：苹果的 Lilian、Yue、
 * Lili、Han，Edge 浏览器自带的 Xiaoxiao 等，Chrome 的 Google 普通话。
 */
const RECOMMENDED_VOICE_PATTERN =
  /lilian|\byue\b|\blili\b|\bhan\b|xiaoxiao|xiaoyi|yunxi|yunjian|yunyang|google 普通话/i;

function voiceScore(voice: SpeechSynthesisVoice): number {
  const lang = voice.lang.toLowerCase().replace(/_/g, "-");
  let score = 0;
  if (lang === "zh" || /^zh-(cn|hans|sg)/.test(lang) || /^cmn-cn/.test(lang)) score += 100;
  else if (lang.startsWith("zh") || lang.startsWith("cmn")) score += 60;
  // 苹果把「增强」「高级」写在 voiceURI 里（com.apple.voice.premium.zh-CN.Lili），名字里没有。
  if (NATURAL_VOICE_PATTERN.test(`${voice.name} ${voice.voiceURI}`)) score += 30;
  if (RECOMMENDED_VOICE_PATTERN.test(voice.name)) score += 20;
  // 退回系统朗读多半是因为网不好，本机就能出声的更靠得住。
  if (voice.localService) score += 10;
  return score;
}

const CJK_CHARS_PER_SECOND = 5.2;
const LATIN_CHARS_PER_SECOND = 15;
const HIGHLIGHT_INTERVAL_MS = 100;
/** 云端失败后先再试一次，间隔这么久。 */
const EDGE_RETRY_DELAY_MS = 1500;
/** 退回系统朗读之后，过多久再试云端；连着失败就翻倍，最多等这么久。 */
const EDGE_COOLDOWN_MS = 30000;
const EDGE_MAX_COOLDOWN_MS = 5 * 60 * 1000;
/** 「本章结束后」在换章前的静音里停下：拼接时章节之间留了 1.8 秒，提前这么多秒停。 */
const CHAPTER_STOP_LEAD_SECONDS = 1.5;
const POSITION_STATE_INTERVAL_MS = 5000;

function estimateCharsPerSecond(text: string, rate: number): number {
  const cjk = text.match(/[㐀-鿿]/g)?.length ?? 0;
  const ratio = text.length ? cjk / text.length : 1;
  return (
    (ratio * CJK_CHARS_PER_SECOND + (1 - ratio) * LATIN_CHARS_PER_SECOND) *
    Math.max(rate, 0.1)
  );
}

function isAndroid(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
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

/** 正在放（或刚放完、暂停着）的这一段。 */
interface Loaded {
  token: number;
  bookId: string;
  engine: "edge" | "system";
  segment: SpeechSegment;
  /** 云端音频和它的时间轴；系统朗读没有。 */
  clip: SpeechClip | null;
  /** 合成这段用的音色。暂停期间换了音色，恢复时就不能接着放旧的。 */
  voice: string;
}

interface PlayOptions {
  /** 云端分段档位。接着上一段往下读时是上一段的下一档，跳位置、起播从 0 档开始。 */
  tier?: SpeechTier;
  /** 第几次尝试；云端失败先再试一次，再失败才退回系统朗读。 */
  attempt?: number;
}

function sameCursor(a: SpeechCursor | null, b: SpeechCursor | null): boolean {
  return Boolean(a && b && a.chapterIndex === b.chapterIndex && a.sentenceIndex === b.sentenceIndex);
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
  const speak = useMemo(
    () => speechReplacer(settings.speechReplacements),
    [settings.speechReplacements]
  );

  const [systemVoices, setSystemVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [location, setLocation] = useState<SpeechLocation | null>(null);
  const [currentSentenceId, setCurrentSentenceId] = useState("");
  const [error, setError] = useState("");
  const [sleepModeState, setSleepModeState] = useState<SleepMode>("off");
  const [sleepDeadline, setSleepDeadline] = useState<number | null>(null);
  const [activeVoiceURI, setActiveVoiceURI] = useState("");
  const [usingFallback, setUsingFallback] = useState(false);
  const [download, setDownload] = useState<SpeechDownload | null>(null);

  const getBookRef = useRef(getBook);
  const settingsRef = useRef(settings);
  const speakRef = useRef(speak);
  const onProgressRef = useRef(onProgress);
  const systemVoicesRef = useRef(systemVoices);
  const locationRef = useRef<SpeechLocation | null>(null);
  /** 用户的意图：应该在出声。系统把音频停了（来电、拔耳机）会被同步成 false。 */
  const playingRef = useRef(false);
  /** 每次起一段新的播放加一；回调里比对它，过期的直接丢掉。 */
  const tokenRef = useRef(0);
  const loadedRef = useRef<Loaded | null>(null);
  /** 正在放静音占位、等云端音频。 */
  const waitingRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const clipUrlRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trackRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const keepAliveRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** 云端什么时候可以再试；0 表示随时可用。 */
  const edgeRetryAtRef = useRef(0);
  const edgeFailuresRef = useRef(0);
  const blockedVoicesRef = useRef(new Set<string>());
  const sleepModeRef = useRef<SleepMode>("off");
  const sleepDeadlineRef = useRef<number | null>(null);
  const sleepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 「本章结束后」停在哪一章之后：目录里这一项的最后一章（续页算在内）。 */
  const sleepLastChapterRef = useRef(-1);
  const downloadAbortRef = useRef<AbortController | null>(null);
  const positionStateAtRef = useRef(0);
  const listenCacheRef = useRef<{ chapters: Book["chapters"]; first: number; listen: ListenChapter } | null>(null);

  // 请求与缓存只此一份，整场收听共用。用 useState 的惰性初始化拿稳定实例：
  // useMemo 允许被丢弃重算，缓存会跟着白丢。
  const [store] = useState(
    () =>
      new SpeechClipStore(
        undefined,
        undefined,
        undefined,
        typeof window === "undefined" ? null : createSpeechPersistence()
      )
  );

  useEffect(() => {
    getBookRef.current = getBook;
  }, [getBook]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    speakRef.current = speak;
  }, [speak]);

  useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);

  useEffect(() => {
    systemVoicesRef.current = systemVoices;
  }, [systemVoices]);

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

  // 能选的只有云端音色；系统语音留着给云端断掉时自动顶上用。
  const voices: PlayerVoice[] = EDGE_VOICES;

  const voiceName = () => edgeVoiceName(settingsRef.current.voiceURI);

  const clearTimers = useCallback(() => {
    if (keepAliveRef.current) {
      clearInterval(keepAliveRef.current);
      keepAliveRef.current = null;
    }
    if (trackRef.current) {
      clearInterval(trackRef.current);
      trackRef.current = null;
    }
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const releaseClip = useCallback(() => {
    if (clipUrlRef.current) {
      URL.revokeObjectURL(clipUrlRef.current);
      clipUrlRef.current = "";
    }
  }, []);

  const silenceAudio = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.onended = null;
    audio.onerror = null;
    audio.removeAttribute("src");
    audio.load();
  }, []);

  /** 目录里这一章（续页并进来）的时长表，锁屏进度条和「拖到第几秒」共用。 */
  const listenFor = useCallback((book: Book, chapterIndex: number): ListenChapter => {
    const toc = tocIndexes(book.chapters);
    const range = tocRange(toc, chapterIndex, book.chapters.length);
    const cached = listenCacheRef.current;
    if (cached && cached.chapters === book.chapters && cached.first === range.first) {
      return cached.listen;
    }
    const listen = listenChapter(book.chapters, range.first, range.last);
    listenCacheRef.current = { chapters: book.chapters, first: range.first, listen };
    return listen;
  }, []);

  /**
   * 锁屏和控制中心上的进度条。按屏幕时钟给（已经除过倍速），跟播放页显示的一致；
   * 位置是这一句的估算起点加上这一句实际已经读了多久。
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
    let within = 0;
    const loaded = loadedRef.current;
    const audio = audioRef.current;
    if (loaded?.clip && audio && loaded.engine === "edge") {
      const span = spanForSentence(loaded.segment, at);
      if (span) {
        within = Math.min(
          Math.max(0, audio.currentTime - timeAt(loaded.clip.timeline, span.start)),
          sentence.end - sentence.start
        );
      }
    }
    const duration = Math.max(chapterDuration(listen) / rate, 1);
    const position = Math.min((sentence.start + within) / rate, duration);
    try {
      session.setPositionState({ duration, playbackRate: 1, position });
    } catch {
      // 个别浏览器对参数挑剔，进度条不是必需的。
    }
  }, [listenFor]);

  /** 把「现在读到哪一句」落到状态和进度上。 */
  const commitSpan = useCallback(
    (book: Book, span: Pick<SpeechSpan, "chapterIndex" | "sentenceIndex" | "sentenceId">) => {
      const current = locationRef.current;
      if (
        current?.bookId === book.id &&
        current.chapterIndex === span.chapterIndex &&
        current.sentenceIndex === span.sentenceIndex
      ) {
        return;
      }
      const nextLocation: SpeechLocation = {
        bookId: book.id,
        chapterIndex: span.chapterIndex,
        sentenceIndex: span.sentenceIndex,
        sentenceId: span.sentenceId,
      };
      locationRef.current = nextLocation;
      setLocation(nextLocation);
      setCurrentSentenceId(span.sentenceId);
      onProgressRef.current(
        book.id,
        positionFor(book, span.chapterIndex, span.sentenceIndex)
      );
      updatePositionState();
    },
    [updatePositionState]
  );

  const commitCursor = useCallback(
    (book: Book, cursor: SpeechCursor) => {
      const position = positionFor(book, cursor.chapterIndex, cursor.sentenceIndex);
      commitSpan(book, {
        chapterIndex: position.chapterIndex,
        sentenceIndex: position.sentenceIndex,
        sentenceId: position.sentenceId,
      });
    },
    [commitSpan]
  );

  const noteVoiceUsed = useCallback((voiceURI: string, fallback: boolean) => {
    setActiveVoiceURI(voiceURI);
    setUsingFallback(fallback);
  }, []);

  /**
   * 停在原地等用户点一下：后台播放被系统拦下、来电打断这类情况不能当成播完，
   * 清掉位置的话迷你播放器会消失，回到前台连「继续」都没得点。
   */
  const holdForResume = useCallback(
    (message: string) => {
      playingRef.current = false;
      waitingRef.current = false;
      clearTimers();
      setIsPlaying(false);
      setIsPaused(true);
      setIsBuffering(false);
      setError(message);
    },
    [clearTimers]
  );

  const stop = useCallback(() => {
    tokenRef.current += 1;
    playingRef.current = false;
    waitingRef.current = false;
    loadedRef.current = null;
    clearTimers();
    abortRef.current?.abort();
    abortRef.current = null;
    store.cancelPending();
    silenceAudio();
    releaseClip();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    // 定时关闭是「这一次收听」的设置，停了就该归零。
    if (sleepTimerRef.current) {
      clearTimeout(sleepTimerRef.current);
      sleepTimerRef.current = null;
    }
    sleepModeRef.current = "off";
    sleepDeadlineRef.current = null;
    setSleepModeState("off");
    setSleepDeadline(null);
    // 迷你播放器是由 location 推出来的，不清掉就永远赖在书库上关不掉。
    locationRef.current = null;
    setLocation(null);
    setCurrentSentenceId("");
    setIsPlaying(false);
    setIsPaused(false);
    setIsBuffering(false);
    setActiveVoiceURI("");
    setUsingFallback(false);
  }, [clearTimers, releaseClip, silenceAudio, store]);

  const clearSleep = useCallback(() => {
    if (sleepTimerRef.current) {
      clearTimeout(sleepTimerRef.current);
      sleepTimerRef.current = null;
    }
    sleepModeRef.current = "off";
    sleepDeadlineRef.current = null;
    setSleepModeState("off");
    setSleepDeadline(null);
  }, []);

  /** 暂停在原地，位置、迷你播放条都留着。用户点暂停、定时关闭到点都走这里。 */
  const pause = useCallback(() => {
    if (!playingRef.current && !waitingRef.current) return;
    playingRef.current = false;
    waitingRef.current = false;
    clearTimers();
    const loaded = loadedRef.current;
    if (loaded?.engine === "system") {
      // 系统朗读的 pause/resume 在 iOS、安卓上都靠不住，干脆停掉，继续时从这一句重读。
      tokenRef.current += 1;
      loadedRef.current = null;
      window.speechSynthesis?.cancel();
    } else {
      audioRef.current?.pause();
      // 还在等音频的那次请求不掐：合成结果会进缓存，继续时直接命中。
      if (!loaded?.clip) loadedRef.current = null;
    }
    setIsPlaying(false);
    setIsPaused(true);
    setIsBuffering(false);
    updatePositionState();
  }, [clearTimers, updatePositionState]);

  /** 定时关闭到点：暂停，「本章结束后」把位置挪到下一章开头，继续时从那里读。 */
  const pauseForSleep = useCallback(
    (resumeAt: SpeechCursor | null) => {
      pause();
      clearSleep();
      if (resumeAt) {
        const at = locationRef.current;
        const book = at ? getBookRef.current(at.bookId) : undefined;
        if (book) commitCursor(book, resumeAt);
      }
    },
    [clearSleep, commitCursor, pause]
  );

  const sleepDue = () =>
    sleepDeadlineRef.current !== null && Date.now() >= sleepDeadlineRef.current;

  /** 云端连不上：记一次失败，按次数翻倍冷却，冷却期间用系统朗读。 */
  const noteEdgeFailure = () => {
    edgeFailuresRef.current += 1;
    edgeRetryAtRef.current =
      Date.now() +
      Math.min(EDGE_COOLDOWN_MS * 2 ** (edgeFailuresRef.current - 1), EDGE_MAX_COOLDOWN_MS);
  };

  const noteEdgeSuccess = () => {
    edgeFailuresRef.current = 0;
    edgeRetryAtRef.current = 0;
  };

  const playAtRef = useRef<
    ((bookId: string, cursor: SpeechCursor, options?: PlayOptions) => void) | null
  >(null);

  /** 一段读完：接下一段，或者在这里按定时关闭停下。 */
  const finishSegment = useCallback(
    (loaded: Loaded) => {
      if (loaded.token !== tokenRef.current || !playingRef.current) return;
      clearTimers();
      const next = loaded.segment.next;
      if (!next) {
        // 全书读完。
        stop();
        return;
      }
      if (sleepDue()) {
        pauseForSleep(next);
        return;
      }
      if (sleepModeRef.current === "chapter" && next.chapterIndex > sleepLastChapterRef.current) {
        pauseForSleep(next);
        return;
      }
      playAtRef.current?.(loaded.bookId, next, {
        tier: loaded.engine === "edge" ? nextTier(loaded.segment.tier) : 0,
      });
    },
    [clearTimers, pauseForSleep, stop]
  );

  /** 云端这一段的进度：高亮、存进度、定时关闭都在这里判断。 */
  const tick = useCallback(() => {
    const loaded = loadedRef.current;
    const audio = audioRef.current;
    if (!loaded || loaded.engine !== "edge" || !loaded.clip || !audio) return;
    if (loaded.token !== tokenRef.current || !playingRef.current || audio.paused) return;
    const book = getBookRef.current(loaded.bookId);
    if (!book) return;
    const time = audio.currentTime;
    commitSpan(book, spanAt(loaded.segment.spans, charIndexAt(loaded.clip.timeline, time)));

    if (sleepDue()) {
      pauseForSleep(null);
      return;
    }
    if (sleepModeRef.current === "chapter") {
      const boundary = loaded.segment.spans.find(
        (span) => span.chapterIndex > sleepLastChapterRef.current
      );
      if (boundary && time >= timeAt(loaded.clip.timeline, boundary.start) - CHAPTER_STOP_LEAD_SECONDS) {
        pauseForSleep({ chapterIndex: boundary.chapterIndex, sentenceIndex: boundary.sentenceIndex });
        return;
      }
    }
    if (Date.now() - positionStateAtRef.current > POSITION_STATE_INTERVAL_MS) {
      updatePositionState();
    }
  }, [commitSpan, pauseForSleep, updatePositionState]);

  const tickRef = useRef(tick);
  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  const startTracking = useCallback(() => {
    if (trackRef.current) clearInterval(trackRef.current);
    trackRef.current = setInterval(() => tickRef.current(), HIGHLIGHT_INTERVAL_MS);
  }, []);

  /**
   * 同一个 audio 元素从头用到尾：换源只换 src，不摘掉元素，媒体会话才不会断。
   * 系统打断（来电、Siri、别的应用放声音、拔耳机）只会暂停元素、不会告诉我们，
   * 必须监听 pause 事件把状态同步过来，否则界面还显示在播、锁屏上的播放键按了没反应。
   */
  const ensureAudio = useCallback((): HTMLAudioElement => {
    if (audioRef.current) return audioRef.current;
    const audio = new Audio();
    audio.preload = "auto";
    audio.addEventListener("pause", () => {
      // 自然播完会先发 pause 再发 ended；换源后紧接着 play() 的也会在这里看到 paused=false。
      if (audio.ended || !audio.paused) return;
      if (!playingRef.current && !waitingRef.current) return;
      // 换成系统朗读时是我们自己把元素停了、摘了 src，不是系统打断。
      if (loadedRef.current?.engine === "system" || !audio.getAttribute("src")) return;
      playingRef.current = false;
      waitingRef.current = false;
      clearTimers();
      setIsPlaying(false);
      setIsPaused(true);
      setIsBuffering(false);
      updatePositionState();
    });
    audio.addEventListener("play", () => {
      // 系统那边直接把声音续上了（比如车机、耳机上的播放键没经过 Media Session）。
      const loaded = loadedRef.current;
      if (playingRef.current || !loaded?.clip || audio.src !== clipUrlRef.current) return;
      if (loaded.token !== tokenRef.current) return;
      playingRef.current = true;
      setIsPlaying(true);
      setIsPaused(false);
      setError("");
      startTracking();
    });
    // 熄屏后定时器会被节流，timeupdate 跟着媒体管线走，高亮和定时关闭靠它兜底。
    audio.addEventListener("timeupdate", () => tickRef.current());
    audioRef.current = audio;
    return audio;
  }, [clearTimers, startTracking, updatePositionState]);

  const playAt = useCallback(
    (bookId: string, cursor: SpeechCursor, options: PlayOptions = {}) => {
      const book = getBookRef.current(bookId);
      if (!book) {
        setError("这本书已经不在书架中");
        stop();
        return;
      }
      const index = speechIndexFor(book.chapters);
      if (ordinalOf(index, cursor) < 0) {
        setError("当前章节没有可朗读内容");
        stop();
        return;
      }

      tokenRef.current += 1;
      const token = tokenRef.current;
      clearTimers();
      abortRef.current?.abort();
      abortRef.current = null;
      // 这里刻意不清空 audio：把 src 摘掉等于告诉系统「这次播放结束了」，
      // 媒体会话一断，后台就再没资格起播下一段。真要换源时直接覆盖 src 即可。
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      playingRef.current = true;
      setIsPlaying(true);
      setIsPaused(false);
      // 退回系统朗读期间要留着提示，否则读完一块就把「云端连不上」抹掉，
      // 用户永远不知道声音为什么变了；其余的旧提示（「点一下继续」之类）开播就该清掉。
      if (Date.now() >= edgeRetryAtRef.current) setError("");

      const speakText = speakRef.current;
      const voice = voiceName();
      const tier = options.tier ?? 0;
      const attempt = options.attempt ?? 0;

      const startSystem = (reason: "fallback" | "content") => {
        if (
          typeof window === "undefined" ||
          !("speechSynthesis" in window) ||
          typeof SpeechSynthesisUtterance === "undefined"
        ) {
          holdForResume("云端语音暂时连不上，点一下重试");
          return;
        }
        const segment = systemSegment(book.chapters, cursor, speakText);
        if (!segment) {
          holdForResume("当前章节没有可朗读内容");
          return;
        }

        waitingRef.current = false;
        setIsBuffering(false);
        silenceAudio();
        releaseClip();
        const loaded: Loaded = { token, bookId, engine: "system", segment, clip: null, voice: "" };
        loadedRef.current = loaded;

        const utterance = new SpeechSynthesisUtterance(segment.text);
        const usableVoices = systemVoicesRef.current.filter(
          (item) => !blockedVoicesRef.current.has(item.voiceURI)
        );
        const selectedVoice =
          usableVoices.find((item) => voiceScore(item) >= 100) ??
          usableVoices.find((item) => voiceScore(item) >= 60);
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
        noteVoiceUsed(selectedVoice?.voiceURI ?? "", reason === "fallback");

        let boundarySeen = false;
        utterance.onboundary = (event) => {
          if (token !== tokenRef.current) return;
          boundarySeen = true;
          commitSpan(book, spanAt(segment.spans, event.charIndex));
        };
        utterance.onend = () => finishSegment(loaded);
        utterance.onerror = (event) => {
          if (token !== tokenRef.current) return;
          if (event.error === "canceled" || event.error === "interrupted") return;
          clearTimers();
          // 在线神经音色断网时会报这几种错，把它拉黑后用本地音色重试一次。
          const recoverable =
            event.error === "network" ||
            event.error === "synthesis-failed" ||
            event.error === "synthesis-unavailable";
          if (recoverable && selectedVoice && !selectedVoice.localService) {
            blockedVoicesRef.current.add(selectedVoice.voiceURI);
            playAtRef.current?.(bookId, cursor, { tier: 0, attempt });
            return;
          }
          holdForResume("系统朗读被中断了，点一下继续");
        };

        commitSpan(book, segment.spans[0]);
        window.speechSynthesis.speak(utterance);

        // 桌面 Chrome 的在线语音念到 15 秒左右会静默截断，定期 pause/resume 能续上。
        // 安卓上 pause 等于直接结束，绝不能这么干；本地语音也没有这个毛病。
        if (!isAndroid() && selectedVoice && !selectedVoice.localService) {
          keepAliveRef.current = setInterval(() => {
            if (token !== tokenRef.current || !playingRef.current) return;
            const synth = window.speechSynthesis;
            if (synth.speaking && !synth.paused) {
              synth.pause();
              synth.resume();
            }
          }, 10000);
        }

        // iOS Safari 不派发 boundary 事件，按朗读速度估算高亮位置，真实事件一到就交还。
        const charsPerSecond = estimateCharsPerSecond(segment.text, utterance.rate);
        let elapsed = 0;
        trackRef.current = setInterval(() => {
          if (token !== tokenRef.current || boundarySeen || !playingRef.current) return;
          elapsed += HIGHLIGHT_INTERVAL_MS;
          commitSpan(book, spanAt(segment.spans, (elapsed / 1000) * charsPerSecond));
          if (sleepDue()) pauseForSleep(null);
        }, HIGHLIGHT_INTERVAL_MS);

        // 冷却到了就在系统朗读这一块的同时悄悄试一下云端：试通了，下一块直接换回云端，
        // 用户只会听到声音变回来，不会多等。
        if (reason === "fallback" && segment.next && Date.now() >= edgeRetryAtRef.current) {
          const probe = speechSegment(index, segment.next, 0, speakText);
          if (probe) {
            store
              .request(probe.text, voice)
              .then(noteEdgeSuccess)
              .catch((probeError: unknown) => {
                if (!isAbortError(probeError)) noteEdgeFailure();
              });
          }
        }
      };

      const beginClip = (segment: SpeechSegment, clip: SpeechClip) => {
        const audio = ensureAudio();
        audio.loop = false;
        const loaded: Loaded = { token, bookId, engine: "edge", segment, clip, voice };
        audio.onended = () => finishSegment(loaded);
        audio.onerror = () => {
          if (token !== tokenRef.current) return;
          holdForResume("这一段没能播出来，点一下继续");
        };
        const previous = clipUrlRef.current;
        const url = URL.createObjectURL(clip.audio);
        clipUrlRef.current = url;
        audio.src = url;
        if (previous) URL.revokeObjectURL(previous);
        audio.defaultPlaybackRate = settingsRef.current.speechRate;
        audio.playbackRate = settingsRef.current.speechRate;

        // 从中途起播：src 刚换上时 currentTime 可能还写不进去，元数据到位后再补一次。
        const startSpan = spanForSentence(segment, cursor) ?? segment.spans[0];
        if (startSpan.start > 0) {
          const seconds = timeAt(clip.timeline, startSpan.start);
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

        waitingRef.current = false;
        loadedRef.current = loaded;
        setIsBuffering(false);
        noteEdgeSuccess();
        noteVoiceUsed(resolvedEdgeVoiceURI(settingsRef.current.voiceURI), false);
        setError("");
        commitSpan(book, startSpan);
        void audio.play().catch(() => {
          if (token !== tokenRef.current) return;
          holdForResume("播放被系统打断了，点一下继续");
        });
        startTracking();
        void prefetchAfter(segment);
      };

      /**
       * 下一段提前备好：本机缓存里有那一整格就搬进内存（之后同步命中），没有就去合成。
       * 播放这一段的几十秒到十几分钟足够盖住下一段的合成时间。
       */
      const prefetchAfter = async (segment: SpeechSegment) => {
        const next = segment.next;
        if (!next) return;
        const cell = gridSegmentAt(index, next, speakText);
        if (cell && (await store.warm(cell.text, voice))) return;
        if (token !== tokenRef.current) return;
        const following = speechSegment(index, next, nextTier(segment.tier), speakText);
        if (following) store.prefetch(following.text, voice);
      };

      const startEdge = () => {
        // 1. 这一整格已经在内存里（离线缓存、之前听过、进播放页时从本机搬上来的）：
        //    直接从格子中间播，不必合成。
        const cell = gridSegmentAt(index, cursor, speakText);
        if (cell && store.has(cell.text, voice)) {
          const clip = store.peek(cell.text, voice);
          if (clip) {
            beginClip(cell, clip);
            return;
          }
        }

        // 2. 按档位取这一段。缓存命中必须走同步路径：中间但凡有一次 await，后台的
        //    play() 就会被 iOS 当成新的自动播放请求拦掉。
        const segment = speechSegment(index, cursor, tier, speakText);
        if (!segment) {
          holdForResume("当前章节没有可朗读内容");
          return;
        }
        const ready = store.peek(segment.text, voice);
        if (ready) {
          beginClip(segment, ready);
          return;
        }

        // 3. 现合成。锁屏后台等网络时绝不能真的停音频，否则 audio session 会被系统
        //    回收，之后 play() 能成功但发不出声音。改放静音占位撑住会话。
        const waitingAudio = ensureAudio();
        waitingAudio.onended = null;
        waitingAudio.onerror = null;
        waitingAudio.loop = true;
        waitingAudio.src = silentClipUrl();
        waitingRef.current = true;
        loadedRef.current = null;
        setIsBuffering(true);
        void waitingAudio.play().catch(() => undefined);

        const controller = new AbortController();
        abortRef.current = controller;
        store
          .request(segment.text, voice, { priority: true, signal: controller.signal })
          .then((clip) => {
            if (token !== tokenRef.current) return;
            if (!playingRef.current) {
              // 等的时候用户暂停了：音频已经进了缓存，继续时直接命中。
              waitingRef.current = false;
              setIsBuffering(false);
              return;
            }
            beginClip(segment, clip);
          })
          .catch((reason: unknown) => {
            if (token !== tokenRef.current || !playingRef.current) return;
            if (isAbortError(reason)) return;
            const serviceDown =
              !(reason instanceof SpeechClipError) || reason.serviceDown;
            if (serviceDown && attempt === 0) {
              // 先别急着换声音：大多是一时的网络抖动，等一下再试一次。
              retryTimerRef.current = setTimeout(() => {
                if (token !== tokenRef.current || !playingRef.current) return;
                playAtRef.current?.(bookId, cursor, { tier, attempt: 1 });
              }, EDGE_RETRY_DELAY_MS);
              return;
            }
            waitingRef.current = false;
            setIsBuffering(false);
            if (serviceDown) {
              noteEdgeFailure();
              setError("云端语音暂时连不上，先用系统声音读，恢复后自动换回");
              startSystem("fallback");
            } else {
              // 这一段文本本身读不出来：这一块用系统声音读过去，下一段照旧走云端。
              setError("这一段云端读不出来，先用系统声音读过去");
              startSystem("content");
            }
          });
      };

      let useEdge = Date.now() >= edgeRetryAtRef.current;
      if (!useEdge) {
        // 冷却期间系统朗读那边已经悄悄把云端试通了、音频也备好了，那就直接换回来。
        const probe = speechSegment(index, cursor, 0, speakText);
        if (probe && store.has(probe.text, voice)) {
          noteEdgeSuccess();
          useEdge = true;
        }
      }
      if (useEdge) startEdge();
      else startSystem("fallback");
    },
    [
      clearTimers,
      commitSpan,
      ensureAudio,
      finishSegment,
      holdForResume,
      noteVoiceUsed,
      pauseForSleep,
      releaseClip,
      silenceAudio,
      startTracking,
      stop,
      store,
    ]
  );

  useEffect(() => {
    playAtRef.current = playAt;
  }, [playAt]);

  /** 「本章结束后」跟着用户跳到的位置走：跳到哪一章，就在那一章读完时停。 */
  const retargetSleepChapter = useCallback((book: Book, chapterIndex: number) => {
    if (sleepModeRef.current !== "chapter") return;
    sleepLastChapterRef.current = tocRange(
      tocIndexes(book.chapters),
      chapterIndex,
      book.chapters.length
    ).last;
  }, []);

  /**
   * 跳到某一句：目标还在已经加载的这段云端音频里就直接改时间轴，不必重新合成；
   * 否则从那里起播。暂停时只挪位置，继续时从那里读。
   */
  const jumpTo = useCallback(
    (bookId: string, cursor: SpeechCursor, keepPaused: boolean) => {
      const book = getBookRef.current(bookId);
      if (!book) return;
      retargetSleepChapter(book, cursor.chapterIndex);
      const loaded = loadedRef.current;
      const audio = audioRef.current;
      if (
        loaded?.clip &&
        audio &&
        loaded.bookId === bookId &&
        loaded.engine === "edge" &&
        loaded.token === tokenRef.current &&
        loaded.voice === voiceName() &&
        audio.src === clipUrlRef.current &&
        !audio.ended
      ) {
        const span = spanForSentence(loaded.segment, cursor);
        if (span) {
          try {
            audio.currentTime = timeAt(loaded.clip.timeline, span.start);
            commitSpan(book, span);
            updatePositionState();
            if (!playingRef.current && !keepPaused) {
              playingRef.current = true;
              setIsPlaying(true);
              setIsPaused(false);
              void audio.play().catch(() => holdForResume("播放被系统打断了，点一下继续"));
              startTracking();
            }
            return;
          } catch {
            // 写不进去（元数据还没到位之类）就老实重开。
          }
        }
      }
      if (keepPaused && !playingRef.current) {
        // 不在已加载的音频里：只记下位置，继续时从这里起播。
        loadedRef.current = null;
        commitCursor(book, cursor);
        return;
      }
      store.cancelPending();
      playAt(bookId, cursor, { tier: 0 });
    },
    [commitCursor, commitSpan, holdForResume, playAt, retargetSleepChapter, startTracking, store, updatePositionState]
  );

  const resume = useCallback(() => {
    const at = locationRef.current;
    if (!at || playingRef.current) return;
    const loaded = loadedRef.current;
    const audio = audioRef.current;
    if (
      loaded?.clip &&
      audio &&
      loaded.engine === "edge" &&
      loaded.token === tokenRef.current &&
      loaded.voice === voiceName() &&
      audio.src === clipUrlRef.current &&
      !audio.ended
    ) {
      playingRef.current = true;
      setIsPlaying(true);
      setIsPaused(false);
      setError("");
      audio.playbackRate = settingsRef.current.speechRate;
      void audio.play().catch(() => {
        if (loaded.token !== tokenRef.current) return;
        holdForResume("播放被系统打断了，点一下继续");
      });
      startTracking();
      updatePositionState();
      return;
    }
    // 用户亲手点继续：之前的云端失败可能只是一时断网，再给它一次机会。
    noteEdgeSuccess();
    playAt(at.bookId, at, { tier: 0 });
  }, [holdForResume, playAt, startTracking, updatePositionState]);

  const toggle = useCallback(() => {
    if (playingRef.current || waitingRef.current) pause();
    else resume();
  }, [pause, resume]);

  const start = useCallback(
    (bookId: string, position?: BookPosition) => {
      const book = getBookRef.current(bookId);
      if (!book) return;
      // 用户主动开播时再给云端一次机会，之前的失败可能只是临时断网。
      noteEdgeSuccess();
      blockedVoicesRef.current.clear();
      const target = position ?? book.listeningPosition ?? initialPosition(book);
      jumpTo(bookId, { chapterIndex: target.chapterIndex, sentenceIndex: target.sentenceIndex }, false);
    },
    [jumpTo]
  );

  const skipSeconds = useCallback(
    (seconds: number) => {
      const at = locationRef.current;
      if (!at || !seconds) return;
      const book = getBookRef.current(at.bookId);
      if (!book) return;
      const rate = Math.max(settingsRef.current.speechRate, 0.1);
      const media = seconds * rate;
      const keepPaused = !playingRef.current;

      const index = speechIndexFor(book.chapters);
      let from: SpeechCursor = at;
      let remaining = media;

      // 在已经加载的云端音频里：按真实时间轴跳，落到那一刻正在读的那一句的开头。
      const loaded = loadedRef.current;
      const audio = audioRef.current;
      if (
        loaded?.clip &&
        audio &&
        loaded.engine === "edge" &&
        loaded.token === tokenRef.current &&
        audio.src === clipUrlRef.current
      ) {
        const { spans } = loaded.segment;
        const { timeline } = loaded.clip;
        const target = audio.currentTime + media;
        const lastStart = timeAt(timeline, spans[spans.length - 1].start);
        if (target >= 0 && target < lastStart) {
          let span = spanAt(spans, charIndexAt(timeline, target));
          const current = spanForSentence(loaded.segment, at);
          if (seconds > 0 && current && span.start <= current.start) {
            // 这一句本身就比跳的秒数还长：至少往前挪到下一句。
            span = spans[spans.indexOf(current) + 1] ?? span;
          }
          jumpTo(at.bookId, span, keepPaused);
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

      // 不在已加载的音频里：按字数估算往前往后挪。
      let target = cursorAfterSeconds(index, from, remaining);
      if (seconds > 0 && target && ordinalOf(index, target) <= ordinalOf(index, at)) {
        target = cursorAt(index, ordinalOf(index, at) + 1) ?? target;
      }
      if (target && !sameCursor(target, at)) jumpTo(at.bookId, target, keepPaused);
      else if (target && seconds < 0) jumpTo(at.bookId, target, keepPaused);
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
      jumpTo(at.bookId, target, !playingRef.current);
    },
    [jumpTo, listenFor]
  );

  /** 按目录换章：续页并在前一章里，跳的是目录里的上一项、下一项。 */
  const changeChapter = useCallback(
    (delta: number) => {
      const at = locationRef.current;
      if (!at) return;
      const book = getBookRef.current(at.bookId);
      if (!book) return;
      const toc = tocIndexes(book.chapters);
      const current = toc.indexOf(tocIndexFor(toc, at.chapterIndex));
      const target = toc[Math.max(0, Math.min(toc.length - 1, current + delta))];
      if (target === undefined) return;
      jumpTo(at.bookId, { chapterIndex: target, sentenceIndex: 0 }, false);
    },
    [jumpTo]
  );

  const setSleepMode = useCallback(
    (mode: SleepMode) => {
      clearSleep();
      sleepModeRef.current = mode;
      setSleepModeState(mode);
      if (mode === "chapter") {
        const at = locationRef.current;
        const book = at ? getBookRef.current(at.bookId) : undefined;
        if (book && at) retargetSleepChapter(book, at.chapterIndex);
        else sleepLastChapterRef.current = Number.POSITIVE_INFINITY;
        return;
      }
      if (mode === "off") return;
      const minutes = Number(mode);
      const deadline = Date.now() + minutes * 60 * 1000;
      sleepDeadlineRef.current = deadline;
      setSleepDeadline(deadline);
      // 前台靠这个定时器；熄屏后定时器可能被节流，播放进度回调里也会检查是否到点。
      sleepTimerRef.current = setTimeout(() => {
        sleepTimerRef.current = null;
        if (playingRef.current || waitingRef.current) pauseForSleep(null);
        else clearSleep();
      }, minutes * 60 * 1000 + 50);
    },
    [clearSleep, pauseForSleep, retargetSleepChapter]
  );

  /**
   * 进到播放页多半就是要听。先把当前位置那一整格从本机缓存搬进内存（听过的、离线缓存过的），
   * 搬不到再去合成首段；点下去时能同步命中、立刻出声。
   */
  const prefetchStart = useCallback(
    (book: Book, position: BookPosition) => {
      if (playingRef.current || waitingRef.current) return;
      if (Date.now() < edgeRetryAtRef.current) return;
      const index = speechIndexFor(book.chapters);
      const cursor = { chapterIndex: position.chapterIndex, sentenceIndex: position.sentenceIndex };
      if (ordinalOf(index, cursor) < 0) return;
      const voice = voiceName();
      const speakText = speakRef.current;
      const cell = gridSegmentAt(index, cursor, speakText);
      void (async () => {
        if (cell && (await store.warm(cell.text, voice))) return;
        if (playingRef.current) return;
        const segment = speechSegment(index, cursor, 0, speakText);
        if (segment && !store.has(segment.text, voice)) store.prefetch(segment.text, voice);
      })();
    },
    [store]
  );

  const cancelDownload = useCallback(() => {
    downloadAbortRef.current?.abort();
    downloadAbortRef.current = null;
    setDownload((current) => (current ? { ...current, running: false } : current));
  }, []);

  /**
   * 离线缓存：从当前位置所在那一格起，到往后数 chapters 个目录项为止，一格一格合成好存进本机。
   * 一次只下一格（Worker 里一格本身就是 4 路并发），不跟正在播放的抢上游。
   */
  const downloadAhead = useCallback(
    (bookId: string, chapters: number) => {
      const book = getBookRef.current(bookId);
      if (!book) return;
      downloadAbortRef.current?.abort();
      const controller = new AbortController();
      downloadAbortRef.current = controller;

      const at = locationRef.current?.bookId === bookId ? locationRef.current : null;
      const from = at ?? book.listeningPosition ?? initialPosition(book);
      const index = speechIndexFor(book.chapters);
      const startOrdinal = Math.max(0, ordinalOf(index, from));
      const toc = tocIndexes(book.chapters);
      const tocPosition = toc.indexOf(tocIndexFor(toc, from.chapterIndex));
      const stopChapter = toc[tocPosition + Math.max(1, chapters)] ?? book.chapters.length;
      const endOrdinal = index.chapterStarts[stopChapter] ?? index.sentences.length;

      const cells: string[] = [];
      for (let cell = 0; cell < index.grid.length; cell += 1) {
        const cellStart = index.grid[cell];
        const cellEnd = index.grid[cell + 1] ?? index.sentences.length;
        if (cellEnd <= startOrdinal || cellStart >= endOrdinal) continue;
        const cursor = cursorAt(index, cellStart);
        const segment = cursor ? speechSegment(index, cursor, 2, speakRef.current) : null;
        if (segment) cells.push(segment.text);
      }
      const voice = voiceName();
      const state: SpeechDownload = { bookId, total: cells.length, done: 0, failed: 0, running: true };
      setDownload(state);

      void (async () => {
        for (const text of cells) {
          if (controller.signal.aborted) return;
          try {
            await store.download(text, voice, controller.signal);
            state.done += 1;
          } catch (reason) {
            if (controller.signal.aborted || isAbortError(reason)) return;
            state.failed += 1;
          }
          setDownload({ ...state });
        }
        if (downloadAbortRef.current === controller) downloadAbortRef.current = null;
        setDownload({ ...state, running: false });
      })();
    },
    [store]
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

  // 播放中换了音色：从当前这句用新音色重读。暂停时只记下来，继续时生效——
  // 这里擅自起播会把「只是想换个声音」变成「突然出声」。
  const requestedVoiceRef = useRef(settings.voiceURI);
  useEffect(() => {
    const next = settings.voiceURI;
    if (next === requestedVoiceRef.current) return;
    requestedVoiceRef.current = next;
    const at = locationRef.current;
    const loaded = loadedRef.current;
    if (!playingRef.current || !at || loaded?.engine !== "edge") return;
    if (loaded.voice === edgeVoiceName(next)) return;
    playAtRef.current?.(at.bookId, at, { tier: 0 });
  }, [settings.voiceURI]);

  // 从后台回到前台时对一下账：后台期间漏掉的 pause 事件在这里补上。
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const audio = audioRef.current;
      const loaded = loadedRef.current;
      if (playingRef.current && loaded?.engine === "edge" && audio?.paused && !audio.ended) {
        playingRef.current = false;
        clearTimers();
        setIsPlaying(false);
        setIsPaused(true);
      }
      if (sleepDue() && (playingRef.current || waitingRef.current)) pauseForSleep(null);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [clearTimers, pauseForSleep]);

  useEffect(
    () => () => {
      if (sleepTimerRef.current) clearTimeout(sleepTimerRef.current);
      if (keepAliveRef.current) clearInterval(keepAliveRef.current);
      if (trackRef.current) clearInterval(trackRef.current);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      abortRef.current?.abort();
      downloadAbortRef.current?.abort();
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
  const actionsRef = useRef({ pause, resume, stop, skipSeconds, changeChapter, seekToClock });
  useEffect(() => {
    actionsRef.current = { pause, resume, stop, skipSeconds, changeChapter, seekToClock };
  }, [pause, resume, stop, skipSeconds, changeChapter, seekToClock]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
      return;
    }
    const session = navigator.mediaSession;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      // 这里不看 playingRef：被系统打断后它已经同步成 false，按播放就是继续。
      ["play", () => actionsRef.current.resume()],
      ["pause", () => actionsRef.current.pause()],
      ["stop", () => actionsRef.current.stop()],
      ["previoustrack", () => actionsRef.current.changeChapter(-1)],
      ["nexttrack", () => actionsRef.current.changeChapter(1)],
      [
        "seekbackward",
        (details) => actionsRef.current.skipSeconds(-(details.seekOffset ?? SKIP_SECONDS)),
      ],
      [
        "seekforward",
        (details) => actionsRef.current.skipSeconds(details.seekOffset ?? SKIP_SECONDS),
      ],
      [
        "seekto",
        (details) => {
          if (typeof details.seekTime === "number") actionsRef.current.seekToClock(details.seekTime);
        },
      ],
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
    updatePositionState();
  }, [sessionBookId, sessionChapterIndex, updatePositionState]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
      return;
    }
    navigator.mediaSession.playbackState = isPlaying
      ? "playing"
      : isPaused
        ? "paused"
        : "none";
    updatePositionState();
  }, [isPlaying, isPaused, updatePositionState]);

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
    usingFallback,
    download,
    start,
    toggle,
    stop,
    skipSeconds,
    changeChapter,
    setSleepMode,
    prefetchStart,
    downloadAhead,
    cancelDownload,
  };
}
