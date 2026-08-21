import type { ReadingSession } from "./types.ts";
import { dayKey } from "./types.ts";

/** 一天读满这么久才算数，连续天数按它判。 */
const STREAK_MIN_SECONDS = 60;

/**
 * 按天汇总。legacy 是早期版本只存了总数的那些天，合进来当历史基数——
 * 它没法下钻到书，所以只参与总量，不出现在时间线里。
 */
export function dailySeconds(
  sessions: ReadingSession[],
  legacy: Record<string, number> = {}
): Record<string, number> {
  const days: Record<string, number> = { ...legacy };
  for (const session of sessions) {
    const key = dayKey(session.startedAt);
    days[key] = (days[key] ?? 0) + session.seconds;
  }
  return days;
}

export function totalSeconds(days: Record<string, number>): number {
  return Object.values(days).reduce((sum, item) => sum + item, 0);
}

/** 连续天数：今天还没读不算断，从昨天往回数。 */
export function readingStreak(
  days: Record<string, number>,
  now: number
): number {
  const cursor = new Date(now);
  if ((days[dayKey(now)] ?? 0) < STREAK_MIN_SECONDS) {
    cursor.setDate(cursor.getDate() - 1);
  }
  let streak = 0;
  while ((days[dayKey(cursor.getTime())] ?? 0) >= STREAK_MIN_SECONDS) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export interface BookTotal {
  bookId: string;
  bookTitle: string;
  seconds: number;
  lastAt: number;
}

/** 每本书累计花了多久，最近读的排前面。 */
export function bookTotals(sessions: ReadingSession[]): BookTotal[] {
  const map = new Map<string, BookTotal>();
  for (const session of sessions) {
    const item = map.get(session.bookId);
    if (item) {
      item.seconds += session.seconds;
      item.lastAt = Math.max(item.lastAt, session.endedAt);
      item.bookTitle = session.bookTitle;
    } else {
      map.set(session.bookId, {
        bookId: session.bookId,
        bookTitle: session.bookTitle,
        seconds: session.seconds,
        lastAt: session.endedAt,
      });
    }
  }
  return [...map.values()].sort((a, b) => b.lastAt - a.lastAt);
}

export interface SessionDay {
  key: string;
  seconds: number;
  sessions: ReadingSession[];
}

/** 时间线：按天倒序分组，天内也按时间倒序。 */
export function groupSessionsByDay(sessions: ReadingSession[]): SessionDay[] {
  const map = new Map<string, SessionDay>();
  for (const session of [...sessions].sort((a, b) => b.startedAt - a.startedAt)) {
    const key = dayKey(session.startedAt);
    const day = map.get(key);
    if (day) {
      day.seconds += session.seconds;
      day.sessions.push(session);
    } else {
      map.set(key, { key, seconds: session.seconds, sessions: [session] });
    }
  }
  return [...map.values()].sort((a, b) => (a.key < b.key ? 1 : -1));
}
