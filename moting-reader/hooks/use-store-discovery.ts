"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { BookMeta, ReadingSession } from "../lib/types";
import {
  getDiscoveryState, getServerDiscoveryState, shuffleDiscovery, shuffleDiscoveryBoard,
  startDiscovery, subscribeDiscovery,
} from "../lib/store-snapshot";

const NO_SESSIONS: readonly ReadingSession[] = [];

/** 两个入口共享快照和换批结果，不重复取书、不在返回时重新抽样。 */
export function useStoreDiscovery(books: readonly BookMeta[], sessions: readonly ReadingSession[] = NO_SESSIONS) {
  const state = useSyncExternalStore(subscribeDiscovery, getDiscoveryState, getServerDiscoveryState);
  useEffect(() => {
    void startDiscovery(books, sessions);
  }, [books, sessions]);
  useEffect(() => {
    const resume = () => {
      if (document.visibilityState === "visible") void startDiscovery(books, sessions);
    };
    document.addEventListener("visibilitychange", resume);
    return () => document.removeEventListener("visibilitychange", resume);
  }, [books, sessions]);
  return { ...state, shuffle: shuffleDiscovery, shuffleBoard: shuffleDiscoveryBoard };
}
