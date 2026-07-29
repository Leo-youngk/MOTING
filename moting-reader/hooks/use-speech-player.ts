"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildSpeechBlocks,
  flattenChapter,
  initialPosition,
  positionFor,
  sliceSpeechBlock,
} from "../lib/content";
import type {
  Book,
  BookPosition,
  Chapter,
  ReaderSettings,
  SpeechBlock,
  SpeechLocation,
  SpeechSpan,
} from "../lib/types";

export type SleepMode = "off" | "15" | "30" | "45" | "chapter";

interface SpeechPlayerOptions {
  books: Book[];
  settings: ReaderSettings;
  onProgress: (bookId: string, position: BookPosition) => void;
}

interface SpeechPlayerState {
  voices: SpeechSynthesisVoice[];
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

function estimateCharsPerSecond(text: string, rate: number): number {
  const cjk = text.match(/[㐀-鿿]/g)?.length ?? 0;
  const ratio = text.length ? cjk / text.length : 1;
  return (
    (ratio * CJK_CHARS_PER_SECOND + (1 - ratio) * LATIN_CHARS_PER_SECOND) *
    Math.max(rate, 0.1)
  );
}

function spanAt(spans: SpeechSpan[], charIndex: number): SpeechSpan {
  let match = spans[0];
  for (const span of spans) {
    if (span.start <= charIndex) match = span;
    else break;
  }
  return match;
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

export function useSpeechPlayer({
  books,
  settings,
  onProgress,
}: SpeechPlayerOptions): SpeechPlayerState {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
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
  const sleepModeRef = useRef<SleepMode>("off");
  const sleepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepAliveRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const estimateRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const blocksCacheRef = useRef(new Map<string, SpeechBlock[]>());
  const blockedVoicesRef = useRef(new Set<string>());
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

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const update = () => {
      const nextVoices = window.speechSynthesis
        .getVoices()
        .slice()
        .sort(
          (a, b) => voiceScore(b) - voiceScore(a) || a.name.localeCompare(b.name)
        );
      setVoices(nextVoices);
    };
    update();
    window.speechSynthesis.addEventListener("voiceschanged", update);
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", update);
    };
  }, []);

  const clearTimers = useCallback(() => {
    if (keepAliveRef.current) {
      clearInterval(keepAliveRef.current);
      keepAliveRef.current = null;
    }
    if (estimateRef.current) {
      clearInterval(estimateRef.current);
      estimateRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    tokenRef.current += 1;
    playingRef.current = false;
    clearTimers();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setIsPlaying(false);
    setIsPaused(false);
  }, [clearTimers]);

  const blocksFor = useCallback((chapter: Chapter): SpeechBlock[] => {
    const cached = blocksCacheRef.current.get(chapter.id);
    if (cached) return cached;
    const blocks = buildSpeechBlocks(chapter);
    blocksCacheRef.current.set(chapter.id, blocks);
    return blocks;
  }, []);

  const playAt = useCallback(
    (bookId: string, chapterIndex: number, sentenceIndex: number) => {
      if (
        typeof window === "undefined" ||
        !("speechSynthesis" in window) ||
        typeof SpeechSynthesisUtterance === "undefined"
      ) {
        setError("当前浏览器没有提供系统朗读能力");
        return;
      }

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
      window.speechSynthesis.cancel();
      setError("");

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

      const utterance = new SpeechSynthesisUtterance(segment.text);
      const usableVoices = voices.filter(
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
        utterance.lang = /[㐀-鿿]/.test(segment.text)
          ? "zh-CN"
          : "en-US";
      }
      utterance.rate = settingsRef.current.speechRate;
      utterance.pitch = 1;
      utterance.volume = 1;

      let boundarySeen = false;

      utterance.onstart = () => {
        if (token !== tokenRef.current) return;
        playingRef.current = true;
        setIsPlaying(true);
        setIsPaused(false);
      };

      utterance.onboundary = (event) => {
        if (token !== tokenRef.current) return;
        boundarySeen = true;
        if (estimateRef.current) {
          clearInterval(estimateRef.current);
          estimateRef.current = null;
        }
        applySpan(spanAt(segment.spans, event.charIndex));
      };

      utterance.onend = () => {
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

      playingRef.current = true;
      setIsPlaying(true);
      setIsPaused(false);
      window.speechSynthesis.speak(utterance);

      // Chrome 播放单条 utterance 约 15 秒后会静默截断，定期 pause/resume 可以让它继续念完整段。
      keepAliveRef.current = setInterval(() => {
        if (token !== tokenRef.current) return;
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
      estimateRef.current = setInterval(() => {
        if (token !== tokenRef.current || boundarySeen) return;
        if (window.speechSynthesis.paused) return;
        elapsed += 250;
        applySpan(spanAt(segment.spans, (elapsed / 1000) * charsPerSecond));
      }, 250);
    },
    [blocksFor, clearTimers, stop, voices]
  );

  useEffect(() => {
    playAtRef.current = playAt;
  }, [playAt]);

  const start = useCallback(
    (bookId: string, position?: BookPosition) => {
      const book = booksRef.current.find((item) => item.id === bookId);
      if (!book) return;
      const nextPosition = position ?? book.listeningPosition ?? initialPosition(book);
      playAt(bookId, nextPosition.chapterIndex, nextPosition.sentenceIndex);
    },
    [playAt]
  );

  const toggle = useCallback(() => {
    if (
      typeof window === "undefined" ||
      !("speechSynthesis" in window)
    ) {
      setError("当前浏览器没有提供系统朗读能力");
      return;
    }
    if (!locationRef.current) return;
    if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
      playingRef.current = true;
      setIsPlaying(true);
      setIsPaused(false);
    } else if (window.speechSynthesis.speaking) {
      window.speechSynthesis.pause();
      setIsPaused(true);
      setIsPlaying(false);
    } else {
      const current = locationRef.current;
      playAt(current.bookId, current.chapterIndex, current.sentenceIndex);
    }
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
      if (estimateRef.current) clearInterval(estimateRef.current);
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    },
    []
  );

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
