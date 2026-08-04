"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildSpeechBlocks,
  flattenChapter,
  initialPosition,
  positionFor,
  sliceSpeechBlock,
} from "../lib/content";
import { EDGE_VOICES, edgeVoiceName, isEdgeVoiceURI } from "../lib/edge-voices";
import {
  fetchSpeechClip,
  SpeechClipError,
  type SpeechClip,
} from "../lib/speech-audio";
import { charIndexAt, spanAt } from "../lib/speech-timeline";
import type {
  Book,
  BookPosition,
  Chapter,
  PlayerVoice,
  ReaderSettings,
  SpeechBlock,
  SpeechBoundary,
  SpeechLocation,
  SpeechSpan,
} from "../lib/types";

export type SleepMode = "off" | "15" | "30" | "45" | "chapter";

type Engine = "edge" | "system";

/** 已经落成 blob URL、可以立刻塞给 audio 的一段音频。 */
interface ReadyClip {
  url: string;
  timeline: SpeechBoundary[];
}

interface PrefetchEntry {
  key: string;
  clip: Promise<SpeechClip>;
  ready: ReadyClip | null;
}

interface SpeechPlayerOptions {
  books: Book[];
  settings: ReaderSettings;
  onProgress: (bookId: string, position: BookPosition) => void;
}

interface SpeechPlayerState {
  voices: PlayerVoice[];
  isPlaying: boolean;
  isPaused: boolean;
  location: SpeechLocation | null;
  currentSentenceId: string;
  error: string;
  sleepMode: SleepMode;
  start: (bookId: string, position?: BookPosition) => void;
  toggle: () => void;
  stop: () => void;
  skipSentences: (delta: number) => void;
  changeChapter: (delta: number) => void;
  setSleepMode: (mode: SleepMode) => void;
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
    if (chapter < 0 || chapter >= book.chapters.length) return null;
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

export function useSpeechPlayer({
  books,
  settings,
  onProgress,
}: SpeechPlayerOptions): SpeechPlayerState {
  const [systemVoices, setSystemVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [location, setLocation] = useState<SpeechLocation | null>(null);
  const [currentSentenceId, setCurrentSentenceId] = useState("");
  const [error, setError] = useState("");
  const [sleepModeState, setSleepModeState] = useState<SleepMode>("off");

  const booksRef = useRef(books);
  const settingsRef = useRef(settings);
  const onProgressRef = useRef(onProgress);
  const locationRef = useRef<SpeechLocation | null>(null);
  const playingRef = useRef(false);
  const tokenRef = useRef(0);
  const engineRef = useRef<Engine | null>(null);
  const sleepModeRef = useRef<SleepMode>("off");
  const sleepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepAliveRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const trackRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const blocksCacheRef = useRef(new Map<string, SpeechBlock[]>());
  const blockedVoicesRef = useRef(new Set<string>());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const clipUrlRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);
  const prefetchRef = useRef<PrefetchEntry | null>(null);
  const edgeDownRef = useRef(false);
  const playAtRef = useRef<
    ((bookId: string, chapterIndex: number, sentenceIndex: number) => void) | null
  >(null);

  useEffect(() => {
    booksRef.current = books;
  }, [books]);

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

  const voices = useMemo<PlayerVoice[]>(
    () => [
      ...EDGE_VOICES,
      ...systemVoices.map((voice) => ({
        voiceURI: voice.voiceURI,
        name: voice.name,
        lang: voice.lang,
      })),
    ],
    [systemVoices]
  );

  const clearTimers = useCallback(() => {
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

  const releasePrefetch = useCallback(() => {
    const ready = prefetchRef.current?.ready;
    if (ready) URL.revokeObjectURL(ready.url);
    prefetchRef.current = null;
  }, []);

  // 后台播放被系统拦下时不能当成播完：清掉位置的话迷你播放器会消失，
  // 回到前台连「继续」都没得点。只置成暂停，原地等用户点一下。
  const holdForResume = useCallback((message: string) => {
    playingRef.current = false;
    setIsPlaying(false);
    setIsPaused(true);
    setError(message);
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

  const stop = useCallback(() => {
    tokenRef.current += 1;
    playingRef.current = false;
    engineRef.current = null;
    clearTimers();
    abortRef.current?.abort();
    abortRef.current = null;
    silenceAudio();
    releaseClip();
    releasePrefetch();
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
  }, [clearTimers, releaseClip, releasePrefetch, silenceAudio]);

  const blocksFor = useCallback((chapter: Chapter): SpeechBlock[] => {
    const cached = blocksCacheRef.current.get(chapter.id);
    if (cached) return cached;
    const blocks = buildSpeechBlocks(chapter);
    blocksCacheRef.current.set(chapter.id, blocks);
    return blocks;
  }, []);

  /** 下一段已经备好了就同步交出来，让块与块之间不留任何 await。 */
  const takeReadyClip = useCallback((key: string): ReadyClip | null => {
    const pending = prefetchRef.current;
    if (pending?.key !== key || !pending.ready) return null;
    prefetchRef.current = null;
    return pending.ready;
  }, []);

  const takeClip = useCallback(
    (text: string, voice: string, signal: AbortSignal): Promise<SpeechClip> => {
      const pending = prefetchRef.current;
      if (pending?.key === `${voice}|${text}`) {
        prefetchRef.current = null;
        return pending.clip;
      }
      releasePrefetch();
      return fetchSpeechClip(text, voice, signal);
    },
    [releasePrefetch]
  );

  const prefetchClip = useCallback(
    (text: string, voice: string) => {
      const key = `${voice}|${text}`;
      if (prefetchRef.current?.key === key) return;
      releasePrefetch();
      const entry: PrefetchEntry = {
        key,
        clip: fetchSpeechClip(text, voice),
        ready: null,
      };
      prefetchRef.current = entry;
      entry.clip
        .then((clip) => {
          // 预取的结果一拿到就先落成 blob URL。交接那一刻只剩「赋 src + play」两步，
          // 中间但凡有一次 await，后台的 play() 就会被当成新的自动播放请求拦掉。
          if (prefetchRef.current !== entry) return;
          entry.ready = {
            url: URL.createObjectURL(clip.audio),
            timeline: clip.timeline,
          };
        })
        // 预取失败不该冒泡成未处理拒绝，真正播到这一段时会重新请求并报错。
        .catch(() => undefined);
    },
    [releasePrefetch]
  );

  const playAt = useCallback(
    (bookId: string, chapterIndex: number, sentenceIndex: number) => {
      const book = booksRef.current.find((item) => item.id === bookId);
      if (!book) {
        setError("这本书已经不在书架中");
        stop();
        return;
      }

      const chapter = book.chapters[chapterIndex];
      const blocks = chapter ? blocksFor(chapter) : [];
      if (!chapter || !blocks.length) {
        setError("当前章节没有可朗读内容");
        stop();
        return;
      }

      const advanceChapter = () => {
        if (chapterIndex + 1 >= book.chapters.length) {
          stop();
          return;
        }
        playAtRef.current?.(bookId, chapterIndex + 1, 0);
      };

      let blockIndex = blocks.findIndex(
        (block) => block.spans[block.spans.length - 1].sentenceIndex >= sentenceIndex
      );
      if (blockIndex < 0) {
        advanceChapter();
        return;
      }

      let segment = sliceSpeechBlock(blocks[blockIndex], sentenceIndex);
      while (!segment.text.trim() && blockIndex + 1 < blocks.length) {
        blockIndex += 1;
        segment = blocks[blockIndex];
      }
      if (!segment.text.trim()) {
        advanceChapter();
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
      // 已经退回系统朗读时要留着提示，否则读完一段就把「云端不可用」抹掉，
      // 用户永远不知道音色为什么变了。
      if (!edgeDownRef.current) setError("");

      const applySpan = (span: SpeechSpan) => {
        if (token !== tokenRef.current) return;
        if (locationRef.current?.sentenceId === span.sentenceId) return;
        const nextLocation: SpeechLocation = {
          bookId,
          chapterIndex,
          sentenceIndex: span.sentenceIndex,
          sentenceId: span.sentenceId,
        };
        locationRef.current = nextLocation;
        setLocation(nextLocation);
        setCurrentSentenceId(span.sentenceId);
        onProgressRef.current(
          bookId,
          positionFor(book, chapterIndex, span.sentenceIndex)
        );
      };

      applySpan(segment.spans[0]);

      const finishSegment = () => {
        if (token !== tokenRef.current || !playingRef.current) return;
        clearTimers();
        const lastSentenceIndex =
          segment.spans[segment.spans.length - 1].sentenceIndex;
        const atChapterEnd = lastSentenceIndex >= chapter.sentenceCount - 1;
        if (sleepModeRef.current === "chapter" && atChapterEnd) {
          stop();
          setSleepModeState("off");
          sleepModeRef.current = "off";
          return;
        }
        if (atChapterEnd) {
          advanceChapter();
          return;
        }
        playAtRef.current?.(bookId, chapterIndex, lastSentenceIndex + 1);
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
            playAtRef.current?.(bookId, chapterIndex, sentenceIndex);
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
          const next = blocks[blockIndex + 1];
          if (next?.text.trim()) {
            prefetchClip(next.text, voiceName);
            return;
          }
          // 本章最后一块没有下一块可预取，但章节交界处同样不能冷场，
          // 提前把下一章开头备好，换章那一刻也走「无缝切换」。
          const nextChapter = book.chapters[chapterIndex + 1];
          const firstOfNext = nextChapter ? blocksFor(nextChapter)[0] : undefined;
          if (firstOfNext?.text.trim()) prefetchClip(firstOfNext.text, voiceName);
        };

        const beginClip = (clip: ReadyClip) => {
          const audio = audioRef.current ?? new Audio();
          audioRef.current = audio;
          audio.loop = false;
          audio.onended = finishSegment;
          audio.onerror = () => {
            if (token !== tokenRef.current) return;
            holdForResume("这一段没能播出来，点一下继续");
          };
          const previous = clipUrlRef.current;
          clipUrlRef.current = clip.url;
          audio.src = clip.url;
          if (previous) URL.revokeObjectURL(previous);
          audio.playbackRate = settingsRef.current.speechRate;
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
        };

        const ready = takeReadyClip(`${voiceName}|${segment.text}`);
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
        void waitingAudio.play().catch(() => undefined);

        const controller = new AbortController();
        abortRef.current = controller;

        takeClip(segment.text, voiceName, controller.signal)
          .then((clip) => {
            if (token !== tokenRef.current || !playingRef.current) return;
            beginClip({
              url: URL.createObjectURL(clip.audio),
              timeline: clip.timeline,
            });
          })
          .catch((reason: unknown) => {
            if (token !== tokenRef.current || !playingRef.current) return;
            // 只有服务真的不可用才拉闸退回系统朗读；单段合成失败下一段还要再试云端，
            // 否则一句超长文本就能让后面整本书都变成机器音。
            const serviceDown =
              !(reason instanceof SpeechClipError) || reason.serviceDown;
            if (serviceDown) {
              edgeDownRef.current = true;
              setError("云端语音暂不可用，已切换到系统朗读");
            } else {
              setError("这一段云端读不了，先用系统朗读");
            }
            startSystem();
          });
      };

      playingRef.current = true;
      setIsPlaying(true);
      setIsPaused(false);

      const voiceURI = settingsRef.current.voiceURI;
      const useEdge =
        !edgeDownRef.current && (!voiceURI || isEdgeVoiceURI(voiceURI));
      if (useEdge) startEdge();
      else startSystem();
    },
    [
      blocksFor,
      clearTimers,
      holdForResume,
      prefetchClip,
      releaseClip,
      silenceAudio,
      stop,
      systemVoices,
      takeClip,
      takeReadyClip,
    ]
  );

  useEffect(() => {
    playAtRef.current = playAt;
  }, [playAt]);

  const start = useCallback(
    (bookId: string, position?: BookPosition) => {
      const book = booksRef.current.find((item) => item.id === bookId);
      if (!book) return;
      // 用户主动开播时再给云端一次机会，之前的失败可能只是临时断网。
      edgeDownRef.current = false;
      // 拉黑的系统音色多半也是那次断网连累的，一起放出来重试。
      blockedVoicesRef.current.clear();
      const nextPosition =
        position ?? book.listeningPosition ?? initialPosition(book);
      playAt(bookId, nextPosition.chapterIndex, nextPosition.sentenceIndex);
    },
    [playAt]
  );

  const toggle = useCallback(() => {
    const current = locationRef.current;
    if (!current) return;

    if (engineRef.current === "edge") {
      const audio = audioRef.current;
      if (playingRef.current) {
        abortRef.current?.abort();
        audio?.pause();
        playingRef.current = false;
        setIsPlaying(false);
        setIsPaused(true);
        return;
      }
      if (audio?.src && !audio.ended) {
        playingRef.current = true;
        setIsPlaying(true);
        setIsPaused(false);
        void audio.play().catch(() => undefined);
        return;
      }
      playAt(current.bookId, current.chapterIndex, current.sentenceIndex);
      return;
    }

    if (engineRef.current === "system") {
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
        playAt(current.bookId, current.chapterIndex, current.sentenceIndex);
      }
      return;
    }

    // 已停止，重新起播；顺便给云端一次机会，之前的失败可能只是临时断网。
    edgeDownRef.current = false;
    playAt(current.bookId, current.chapterIndex, current.sentenceIndex);
  }, [playAt]);

  const skipSentences = useCallback(
    (delta: number) => {
      const current = locationRef.current;
      if (!current) return;
      const book = booksRef.current.find((item) => item.id === current.bookId);
      if (!book) return;
      const next = locationAfter(
        book,
        current.chapterIndex,
        current.sentenceIndex,
        delta
      );
      if (!next) return;
      playAt(book.id, next.chapterIndex, next.sentenceIndex);
    },
    [playAt]
  );

  const changeChapter = useCallback(
    (delta: number) => {
      const current = locationRef.current;
      if (!current) return;
      const book = booksRef.current.find((item) => item.id === current.bookId);
      if (!book) return;
      const chapterIndex = Math.max(
        0,
        Math.min(book.chapters.length - 1, current.chapterIndex + delta)
      );
      playAt(book.id, chapterIndex, 0);
    },
    [playAt]
  );

  const setSleepMode = useCallback(
    (mode: SleepMode) => {
      if (sleepTimerRef.current) {
        clearTimeout(sleepTimerRef.current);
        sleepTimerRef.current = null;
      }
      sleepModeRef.current = mode;
      setSleepModeState(mode);
      if (mode === "15" || mode === "30" || mode === "45") {
        sleepTimerRef.current = setTimeout(() => {
          stop();
          sleepModeRef.current = "off";
          setSleepModeState("off");
        }, Number(mode) * 60 * 1000);
      }
    },
    [stop]
  );

  useEffect(
    () => () => {
      if (sleepTimerRef.current) clearTimeout(sleepTimerRef.current);
      if (keepAliveRef.current) clearInterval(keepAliveRef.current);
      if (trackRef.current) clearInterval(trackRef.current);
      abortRef.current?.abort();
      audioRef.current?.pause();
      if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current);
      const ready = prefetchRef.current?.ready;
      if (ready) URL.revokeObjectURL(ready.url);
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
    const book = booksRef.current.find((item) => item.id === sessionBookId);
    if (!book) {
      session.metadata = null;
      return;
    }
    session.metadata = new MediaMetadata({
      title: book.chapters[sessionChapterIndex]?.title ?? book.title,
      artist: book.author || "墨听",
      album: book.title,
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
    location,
    currentSentenceId,
    error,
    sleepMode: sleepModeState,
    start,
    toggle,
    stop,
    skipSentences,
    changeChapter,
    setSleepMode,
  };
}
