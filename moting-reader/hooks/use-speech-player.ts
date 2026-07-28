"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flattenChapter, initialPosition, positionFor } from "../lib/content";
import type {
  Book,
  BookPosition,
  ReaderSettings,
  SpeechLocation,
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
        .sort((a, b) => {
          const aChinese = /^zh/i.test(a.lang) ? 0 : 1;
          const bChinese = /^zh/i.test(b.lang) ? 0 : 1;
          return aChinese - bChinese || a.name.localeCompare(b.name);
        });
      setVoices(nextVoices);
    };
    update();
    window.speechSynthesis.addEventListener("voiceschanged", update);
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", update);
    };
  }, []);

  const stop = useCallback(() => {
    tokenRef.current += 1;
    playingRef.current = false;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setIsPlaying(false);
    setIsPaused(false);
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
      const sentence = chapter && flattenChapter(chapter)[sentenceIndex];
      if (!chapter || !sentence) {
        setError("当前章节没有可朗读内容");
        stop();
        return;
      }

      tokenRef.current += 1;
      const token = tokenRef.current;
      window.speechSynthesis.cancel();
      setError("");

      const nextLocation: SpeechLocation = {
        bookId,
        chapterIndex,
        sentenceIndex,
        sentenceId: sentence.id,
      };
      locationRef.current = nextLocation;
      setLocation(nextLocation);
      setCurrentSentenceId(sentence.id);
      const position = positionFor(book, chapterIndex, sentenceIndex);
      onProgressRef.current(bookId, position);

      const utterance = new SpeechSynthesisUtterance(
        sentence.speakableText || sentence.text
      );
      const selectedVoice =
        voices.find(
          (voice) => voice.voiceURI === settingsRef.current.voiceURI
        ) ??
        voices.find((voice) => /^zh-(CN|Hans)/i.test(voice.lang)) ??
        voices.find((voice) => /^zh/i.test(voice.lang));
      if (selectedVoice) {
        utterance.voice = selectedVoice;
        utterance.lang = selectedVoice.lang;
      } else {
        utterance.lang = /[\u3400-\u9fff]/.test(sentence.text)
          ? "zh-CN"
          : "en-US";
      }
      utterance.rate = settingsRef.current.speechRate;
      utterance.pitch = 1;
      utterance.volume = 1;

      utterance.onstart = () => {
        if (token !== tokenRef.current) return;
        playingRef.current = true;
        setIsPlaying(true);
        setIsPaused(false);
      };

      utterance.onend = () => {
        if (token !== tokenRef.current || !playingRef.current) return;
        const latestBook = booksRef.current.find((item) => item.id === bookId);
        if (!latestBook) {
          stop();
          return;
        }
        const currentChapterSentences = flattenChapter(
          latestBook.chapters[chapterIndex]
        );
        const atChapterEnd =
          sentenceIndex >= currentChapterSentences.length - 1;
        if (sleepModeRef.current === "chapter" && atChapterEnd) {
          stop();
          setSleepModeState("off");
          sleepModeRef.current = "off";
          return;
        }
        const next = locationAfter(
          latestBook,
          chapterIndex,
          sentenceIndex,
          1
        );
        if (!next) {
          stop();
          return;
        }
        playAtRef.current?.(bookId, next.chapterIndex, next.sentenceIndex);
      };

      utterance.onerror = (event) => {
        if (token !== tokenRef.current) return;
        if (event.error === "canceled" || event.error === "interrupted") return;
        setError("系统朗读被中断，请重新播放");
        stop();
      };

      playingRef.current = true;
      setIsPlaying(true);
      setIsPaused(false);
      window.speechSynthesis.speak(utterance);
    },
    [stop, voices]
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
