import type { ReadingKind, ReadingSession } from "./types.ts";
import { dayKey } from "./types.ts";

/** 一轮心跳最多认这么多秒。页面切后台后定时器会被压到几分钟一跳，超出的当没在读。 */
export const MAX_TICK_SECONDS = 90;
/**
 * 听书那一跳的上限。锁屏后台放着本来就该算，可系统会让 JS 一睡就是一整段音频
 * （播放器特意用长批次，最长 4800 字，0.6× 下将近半小时），醒来那一跳要是也按 90 秒钳位，
 * 后台听的时长几乎全丢。暂停、停止都会让目标变掉、当场结账（见 use-reading-session），
 * 所以两跳之间一直在放，照实算；这个上限只防系统打断了播放却没报暂停时多记。
 */
export const MAX_LISTEN_TICK_SECONDS = 30 * 60;
/** 短于这个数的段落不落账，翻两下就退出来的不算一次阅读。 */
export const MIN_SESSION_SECONDS = 20;

export interface SessionInput {
  bookId: string;
  bookTitle: string;
  kind: ReadingKind;
  percent: number;
  /** 这一刻算不算在读：阅读态要页面可见且近期有动作，收听态以在放为准。 */
  countable: boolean;
  now: number;
}

export interface SessionState {
  session: ReadingSession | null;
  lastTickAt: number;
}

export const EMPTY_SESSION_STATE: SessionState = {
  session: null,
  lastTickAt: 0,
};

function sameTarget(session: ReadingSession, input: SessionInput): boolean {
  return (
    session.bookId === input.bookId &&
    session.kind === input.kind &&
    dayKey(session.startedAt) === dayKey(input.now)
  );
}

function open(input: SessionInput): ReadingSession {
  return {
    id: `${input.now}-${Math.random().toString(36).slice(2, 8)}`,
    bookId: input.bookId,
    bookTitle: input.bookTitle,
    kind: input.kind,
    startedAt: input.now,
    endedAt: input.now,
    seconds: 0,
    startPercent: input.percent,
    endPercent: input.percent,
  };
}

/**
 * 推进记时。input 为 null 表示离开了读/听页面，当场封账。
 * 返回的 closed 是这一步刚落定、需要写库的记录（太短的已被丢掉）。
 */
export function advanceSession(
  state: SessionState,
  input: SessionInput | null
): { state: SessionState; closed: ReadingSession | null } {
  const current = state.session;
  const closed =
    current && current.seconds >= MIN_SESSION_SECONDS ? current : null;

  if (!input) {
    return { state: EMPTY_SESSION_STATE, closed };
  }

  if (!current || !sameTarget(current, input)) {
    return {
      state: { session: open(input), lastTickAt: input.now },
      closed,
    };
  }

  if (!input.countable) {
    // 挂机不计时，但也不封账——回来接着读还算同一段。
    return { state: { session: current, lastTickAt: input.now }, closed: null };
  }

  const elapsed = Math.round((input.now - state.lastTickAt) / 1000);
  const cap = input.kind === "listen" ? MAX_LISTEN_TICK_SECONDS : MAX_TICK_SECONDS;
  const gain = elapsed > 0 ? Math.min(elapsed, cap) : 0;

  return {
    state: {
      session: {
        ...current,
        endedAt: input.now,
        seconds: current.seconds + gain,
        endPercent: input.percent,
      },
      lastTickAt: input.now,
    },
    closed: null,
  };
}
