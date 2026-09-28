import type {
  LeafletStore,
  ReadingDayRecord,
  ReadingSessionRecord,
} from "@/lib/db/types";
import type { BookReadingTotals, ReadingOverview } from "./types";

export const DEFAULT_GOAL_SECONDS = 15 * 60;
export const MIN_GOAL_SECONDS = 60;
export const MAX_GOAL_SECONDS = 8 * 60 * 60;
/** A day counts toward a streak at this many seconds, or the goal if lower. */
export const STREAK_FLOOR_SECONDS = 60;
const WPM_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const WPM_MIN_SESSION_SECONDS = 60;
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/u;
/**
 * A word is a run of letters/digits (with inner apostrophes or hyphens), or a
 * single CJK character, since those scripts do not separate words with spaces.
 */
const WORD =
  /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}])+(?:['’‐-]+(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}])+)*/gu;

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** The device's local calendar day, `YYYY-MM-DD`. */
export function localDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDateKey(key: string): [number, number, number] {
  const match = DAY_KEY.exec(key);
  if (!match) {
    throw new Error(`Not a local day key: ${key}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** The day key `days` calendar days after `key` (negative moves back). */
export function dateKeyOffset(key: string, days: number): string {
  const [year, month, day] = parseDateKey(key);
  return localDateKey(new Date(year, month - 1, day + days).getTime());
}

/** Local midnight that starts the day containing `timestamp`. */
export function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate()
  ).getTime();
}

/** Local midnight that ends the day containing `timestamp`. */
export function nextLocalMidnight(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + 1
  ).getTime();
}

/** Cheap, Unicode-aware word count. */
export function countWords(text: string): number {
  let count = 0;
  for (const _match of text.matchAll(WORD)) {
    count += 1;
  }
  return count;
}

export function emptyReadingDay(date: string): ReadingDayRecord {
  return { date, seconds: 0, words: 0, pages: 0, bookIds: [], updatedAt: 0 };
}

export function clampGoalSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) {
    return DEFAULT_GOAL_SECONDS;
  }
  return Math.round(
    Math.min(MAX_GOAL_SECONDS, Math.max(MIN_GOAL_SECONDS, seconds))
  );
}

export async function readingGoalSeconds(store: LeafletStore): Promise<number> {
  const goal = await store.getSetting("readingGoal");
  return goal ? clampGoalSeconds(goal.secondsPerDay) : DEFAULT_GOAL_SECONDS;
}

export async function setReadingGoal(
  store: LeafletStore,
  secondsPerDay: number
): Promise<void> {
  await store.putSetting("readingGoal", {
    secondsPerDay: clampGoalSeconds(secondsPerDay),
  });
}

function meets(record: ReadingDayRecord | undefined, threshold: number) {
  return (record?.seconds ?? 0) >= threshold;
}

/** Consecutive qualifying days ending today, or yesterday when today is still empty. */
export function currentStreak(
  byDate: ReadonlyMap<string, ReadingDayRecord>,
  today: string,
  threshold: number
): number {
  let cursor = meets(byDate.get(today), threshold)
    ? today
    : dateKeyOffset(today, -1);
  let streak = 0;
  while (meets(byDate.get(cursor), threshold)) {
    streak += 1;
    cursor = dateKeyOffset(cursor, -1);
  }
  return streak;
}

/** Longest run of consecutive qualifying days in the whole ledger. */
export function longestStreak(
  records: readonly ReadingDayRecord[],
  threshold: number
): number {
  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date));
  let best = 0;
  let run = 0;
  let previous: string | null = null;
  for (const record of sorted) {
    if (!meets(record, threshold)) {
      continue;
    }
    run =
      previous !== null && dateKeyOffset(previous, 1) === record.date
        ? run + 1
        : 1;
    previous = record.date;
    best = Math.max(best, run);
  }
  return best;
}

function lastDays(
  byDate: ReadonlyMap<string, ReadingDayRecord>,
  today: string,
  count: number
): ReadingDayRecord[] {
  const days: ReadingDayRecord[] = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const key = dateKeyOffset(today, -back);
    days.push(byDate.get(key) ?? emptyReadingDay(key));
  }
  return days;
}

function averageWpm(
  sessions: readonly ReadingSessionRecord[],
  now: number
): number | null {
  let words = 0;
  let seconds = 0;
  for (const session of sessions) {
    if (
      session.startedAt >= now - WPM_WINDOW_MS &&
      session.seconds >= WPM_MIN_SESSION_SECONDS &&
      session.words > 0
    ) {
      words += session.words;
      seconds += session.seconds;
    }
  }
  return seconds > 0 ? Math.round(words / (seconds / 60)) : null;
}

function perBookTotals(
  sessions: readonly ReadingSessionRecord[]
): Record<string, BookReadingTotals> {
  const totals: Record<string, BookReadingTotals> = {};
  for (const session of sessions) {
    const entry = totals[session.bookId] ?? {
      seconds: 0,
      words: 0,
      lastReadAt: 0,
    };
    entry.seconds += session.seconds;
    entry.words += session.words;
    entry.lastReadAt = Math.max(entry.lastReadAt, session.endedAt);
    totals[session.bookId] = entry;
  }
  return totals;
}

export async function readingOverview(
  store: LeafletStore,
  options: { days?: number; now?: () => number } = {}
): Promise<ReadingOverview> {
  const now = options.now?.() ?? Date.now();
  const dayCount = Math.max(1, options.days ?? 28);
  const [records, goalSeconds, sessions] = await Promise.all([
    store.listReadingDays("0000-00-00"),
    readingGoalSeconds(store),
    store.listReadingSessions(),
  ]);
  const byDate = new Map(records.map((record) => [record.date, record]));
  const today = localDateKey(now);
  const todayRecord = byDate.get(today) ?? emptyReadingDay(today);
  const threshold = Math.min(goalSeconds, STREAK_FLOOR_SECONDS);
  const books = new Set<string>();
  let totalSeconds = 0;
  let totalWords = 0;
  for (const record of records) {
    totalSeconds += record.seconds;
    totalWords += record.words;
    for (const id of record.bookIds) {
      books.add(id);
    }
  }
  return {
    todaySeconds: todayRecord.seconds,
    todayWords: todayRecord.words,
    todayPages: todayRecord.pages,
    goalSeconds,
    goalMet: todayRecord.seconds >= goalSeconds,
    streakDays: currentStreak(byDate, today, threshold),
    bestStreak: longestStreak(records, threshold),
    days: lastDays(byDate, today, dayCount),
    totalSeconds,
    totalWords,
    booksTouched: books.size,
    averageWpm: averageWpm(sessions, now),
    perBook: perBookTotals(sessions),
  };
}
