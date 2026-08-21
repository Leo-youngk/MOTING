"use client";

import { useEffect, useRef } from "react";
import {
  EMPTY_SESSION_STATE,
  MIN_SESSION_SECONDS,
  advanceSession,
  type SessionState,
} from "../lib/reading-session";
import type { ReadingKind, ReadingSession } from "../lib/types";

/** 记一次时的间隔。比 MAX_TICK_SECONDS 短得多，正常前台不会被钳位。 */
const TICK_MS = 15000;
/** 阅读态静止超过这么久就当人走开了，不再续时。 */
const IDLE_MS = 180000;

export interface ReadingTarget {
  bookId: string;
  bookTitle: string;
  kind: ReadingKind;
  percent: number;
}

/**
 * 把「正在读/正在听」记成一条条 session。
 *
 * 阅读态要页面可见且近期有动作才算数，纯挂机不计；收听态以在放为准，
 * 锁屏后台放着也照算——那本来就是听书的用法。
 */
export function useReadingSession(
  target: ReadingTarget | null,
  listening: boolean,
  persist: (session: ReadingSession) => void
) {
  const targetRef = useRef(target);
  const listeningRef = useRef(listening);
  const persistRef = useRef(persist);
  const stateRef = useRef<SessionState>(EMPTY_SESSION_STATE);
  const lastActiveRef = useRef(Date.now());

  targetRef.current = target;
  listeningRef.current = listening;
  persistRef.current = persist;

  const key = target ? `${target.kind}:${target.bookId}` : "";

  useEffect(() => {
    const tick = () => {
      const current = targetRef.current;
      const now = Date.now();
      const countable =
        current?.kind === "listen"
          ? listeningRef.current
          : document.visibilityState === "visible" &&
            now - lastActiveRef.current < IDLE_MS;
      const { state, closed } = advanceSession(
        stateRef.current,
        current ? { ...current, countable, now } : null
      );
      stateRef.current = state;
      // 落定的和还在进行的都写库（同 id 覆盖）：中途关掉页面也不会丢这一段。
      if (closed) persistRef.current(closed);
      if (state.session && state.session.seconds >= MIN_SESSION_SECONDS) {
        persistRef.current(state.session);
      }
    };

    const bump = () => {
      lastActiveRef.current = Date.now();
    };

    // 换书、换模式、退出阅读，立刻结账，不等下一跳。
    tick();

    const timer = window.setInterval(tick, TICK_MS);
    document.addEventListener("scroll", bump, true);
    document.addEventListener("pointerdown", bump, true);
    document.addEventListener("keydown", bump, true);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("pagehide", tick);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("scroll", bump, true);
      document.removeEventListener("pointerdown", bump, true);
      document.removeEventListener("keydown", bump, true);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("pagehide", tick);
      tick();
    };
  }, [key]);
}
