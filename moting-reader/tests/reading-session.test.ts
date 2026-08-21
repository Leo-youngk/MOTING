import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_SESSION_STATE,
  MAX_TICK_SECONDS,
  advanceSession,
  type SessionInput,
  type SessionState,
} from "../lib/reading-session.ts";
import {
  dailyBookEntries,
  dailySeconds,
  groupEntriesByMonth,
  readingStreak,
  totalSeconds,
} from "../lib/reading-stats.ts";
import type { ReadingSession } from "../lib/types.ts";

/** 2026-08-20 09:00 本地时间。 */
const BASE = new Date(2026, 7, 20, 9, 0, 0).getTime();

function input(over: Partial<SessionInput> = {}): SessionInput {
  return {
    bookId: "b1",
    bookTitle: "论语",
    kind: "read",
    percent: 10,
    countable: true,
    now: BASE,
    ...over,
  };
}

function run(steps: (SessionInput | null)[]): {
  state: SessionState;
  closed: ReadingSession[];
} {
  let state = EMPTY_SESSION_STATE;
  const closed: ReadingSession[] = [];
  for (const step of steps) {
    const result = advanceSession(state, step);
    state = result.state;
    if (result.closed) closed.push(result.closed);
  }
  return { state, closed };
}

test("连续心跳按真实间隔累加秒数并跟进进度", () => {
  const { state } = run([
    input({ now: BASE }),
    input({ now: BASE + 15000, percent: 12 }),
    input({ now: BASE + 30000, percent: 15 }),
  ]);
  assert.equal(state.session?.seconds, 30);
  assert.equal(state.session?.startPercent, 10);
  assert.equal(state.session?.endPercent, 15);
});

test("挂机的那几跳不计时，回来接着算同一段", () => {
  const { state, closed } = run([
    input({ now: BASE }),
    input({ now: BASE + 15000, countable: false }),
    input({ now: BASE + 30000, countable: false }),
    input({ now: BASE + 45000 }),
  ]);
  assert.equal(closed.length, 0);
  assert.equal(state.session?.seconds, 15);
});

test("后台压住定时器造成的超长间隔按上限钳位", () => {
  const { state } = run([input({ now: BASE }), input({ now: BASE + 600000 })]);
  assert.equal(state.session?.seconds, MAX_TICK_SECONDS);
});

test("换书封账重开，短于下限的那段丢掉", () => {
  const long = run([
    input({ now: BASE }),
    input({ now: BASE + 60000 }),
    input({ now: BASE + 60001, bookId: "b2", bookTitle: "孟子" }),
  ]);
  assert.equal(long.closed.length, 1);
  assert.equal(long.closed[0]?.bookId, "b1");
  assert.equal(long.state.session?.bookId, "b2");
  assert.equal(long.state.session?.seconds, 0);

  const short = run([
    input({ now: BASE }),
    input({ now: BASE + 5000 }),
    input({ now: BASE + 5001, bookId: "b2", bookTitle: "孟子" }),
  ]);
  assert.equal(short.closed.length, 0);
});

test("读和听算两段", () => {
  const { closed, state } = run([
    input({ now: BASE }),
    input({ now: BASE + 60000 }),
    input({ now: BASE + 60001, kind: "listen" }),
  ]);
  assert.equal(closed[0]?.kind, "read");
  assert.equal(state.session?.kind, "listen");
});

test("跨过零点自动切成两段，各自落在自己那天", () => {
  const beforeMidnight = new Date(2026, 7, 20, 23, 59, 0).getTime();
  const afterMidnight = new Date(2026, 7, 21, 0, 1, 0).getTime();
  const { closed, state } = run([
    input({ now: beforeMidnight - 120000 }),
    input({ now: beforeMidnight }),
    input({ now: afterMidnight }),
  ]);
  assert.equal(closed.length, 1);
  assert.equal(new Date(closed[0]!.startedAt).getDate(), 20);
  assert.equal(new Date(state.session!.startedAt).getDate(), 21);
});

test("离开阅读页当场封账", () => {
  const { closed, state } = run([
    input({ now: BASE }),
    input({ now: BASE + 60000 }),
    null,
  ]);
  assert.equal(closed.length, 1);
  assert.equal(closed[0]?.seconds, 60);
  assert.equal(state.session, null);
});

function session(over: Partial<ReadingSession>): ReadingSession {
  return {
    id: "s",
    bookId: "b1",
    bookTitle: "论语",
    kind: "read",
    startedAt: BASE,
    endedAt: BASE + 60000,
    seconds: 60,
    startPercent: 0,
    endPercent: 5,
    ...over,
  };
}

test("按天汇总把旧版历史基数合进来", () => {
  const days = dailySeconds(
    [session({ id: "a", seconds: 100 }), session({ id: "b", seconds: 50 })],
    { "2026-08-19": 300, "2026-08-20": 200 }
  );
  assert.equal(days["2026-08-20"], 350);
  assert.equal(days["2026-08-19"], 300);
  assert.equal(totalSeconds(days), 650);
});

test("连续天数：今天没读不算断，昨天没读就断", () => {
  const now = new Date(2026, 7, 20, 9, 0, 0).getTime();
  assert.equal(
    readingStreak({ "2026-08-19": 120, "2026-08-18": 120 }, now),
    2
  );
  assert.equal(readingStreak({ "2026-08-18": 120 }, now), 0);
  // 不到一分钟的那天不算数。
  assert.equal(readingStreak({ "2026-08-20": 30, "2026-08-19": 120 }, now), 1);
});

test("同一天同一本书合成一条，按天倒序、天内按时长倒序", () => {
  const yesterday = new Date(2026, 7, 19, 9, 0, 0).getTime();
  const entries = dailyBookEntries([
    session({ id: "a", startedAt: BASE, seconds: 60 }),
    session({ id: "b", startedAt: BASE + 3600000, seconds: 20 }),
    session({
      id: "c",
      startedAt: BASE,
      bookId: "b2",
      bookTitle: "孟子",
      seconds: 300,
    }),
    session({ id: "d", startedAt: yesterday, seconds: 30 }),
  ]);
  assert.deepEqual(
    entries.map((item) => [item.key, item.bookId, item.seconds]),
    [
      ["2026-08-20", "b2", 300],
      ["2026-08-20", "b1", 80],
      ["2026-08-19", "b1", 30],
    ]
  );
});

test("历史页按月倒序分栏并汇总当月时长", () => {
  const lastMonth = new Date(2026, 6, 30, 9, 0, 0).getTime();
  const months = groupEntriesByMonth(
    dailyBookEntries([
      session({ id: "a", startedAt: BASE, seconds: 60 }),
      session({ id: "b", startedAt: lastMonth, seconds: 30 }),
    ])
  );
  assert.deepEqual(
    months.map((month) => [month.key, month.seconds]),
    [
      ["2026-08", 60],
      ["2026-07", 30],
    ]
  );
});
