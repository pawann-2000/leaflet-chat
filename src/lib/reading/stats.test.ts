import { describe, expect, it } from "vitest";
import type { LeafletStore } from "@/lib/db/types";
import {
  clampGoalSeconds,
  countWords,
  currentStreak,
  DEFAULT_GOAL_SECONDS,
  dateKeyOffset,
  localDateKey,
  longestStreak,
  nextLocalMidnight,
  readingOverview,
  setReadingGoal,
  startOfLocalDay,
} from "./stats";
import { memoryStore } from "./testing";

const NOON = new Date(2026, 8, 28, 12, 0, 0).getTime(); // local 2026-09-28
const DAY = 24 * 60 * 60 * 1000;

describe("local day keys", () => {
  it("formats the device's local calendar day", () => {
    expect(localDateKey(new Date(2026, 8, 28, 23, 59, 59).getTime())).toBe(
      "2026-09-28"
    );
    expect(localDateKey(new Date(2026, 0, 5, 0, 0, 0).getTime())).toBe(
      "2026-01-05"
    );
  });

  it("offsets across month and year boundaries", () => {
    expect(dateKeyOffset("2026-03-01", -1)).toBe("2026-02-28");
    expect(dateKeyOffset("2026-12-31", 1)).toBe("2027-01-01");
    expect(dateKeyOffset("2026-09-28", -28)).toBe("2026-08-31");
    expect(() => dateKeyOffset("nope", 1)).toThrow("Not a local day key");
  });

  it("finds the local midnights around a timestamp", () => {
    expect(startOfLocalDay(NOON)).toBe(new Date(2026, 8, 28).getTime());
    expect(nextLocalMidnight(NOON)).toBe(new Date(2026, 8, 29).getTime());
  });
});

describe("countWords", () => {
  it("counts words with inner apostrophes and hyphens as one", () => {
    expect(countWords("Hello, world! It's a well-known fact: 42 apples.")).toBe(
      8
    );
  });

  it("counts CJK characters individually and ignores punctuation", () => {
    expect(countWords("今日は良い天気")).toBe(7);
    expect(countWords("abc 漢字 def")).toBe(4);
    expect(countWords("… — !!")).toBe(0);
    expect(countWords("")).toBe(0);
  });
});

describe("streaks", () => {
  const day = (date: string, seconds: number) => ({
    date,
    seconds,
    words: 0,
    pages: 0,
    bookIds: [],
    updatedAt: 0,
  });

  it("counts back from today when today qualifies", () => {
    const byDate = new Map(
      [
        day("2026-09-28", 900),
        day("2026-09-27", 700),
        day("2026-09-26", 30),
        day("2026-09-25", 100),
      ].map((record) => [record.date, record])
    );
    expect(currentStreak(byDate, "2026-09-28", 60)).toBe(2);
  });

  it("keeps yesterday's streak alive while today is still empty", () => {
    const byDate = new Map(
      [day("2026-09-27", 700), day("2026-09-26", 90)].map((record) => [
        record.date,
        record,
      ])
    );
    expect(currentStreak(byDate, "2026-09-28", 60)).toBe(2);
  });

  it("breaks on a gap", () => {
    const byDate = new Map(
      [day("2026-09-28", 900), day("2026-09-26", 900)].map((record) => [
        record.date,
        record,
      ])
    );
    expect(currentStreak(byDate, "2026-09-28", 60)).toBe(1);
    expect(currentStreak(new Map(), "2026-09-28", 60)).toBe(0);
  });

  it("finds the longest historical run", () => {
    expect(
      longestStreak(
        [
          day("2026-09-01", 100),
          day("2026-09-02", 100),
          day("2026-09-03", 10),
          day("2026-09-04", 100),
          day("2026-09-10", 100),
          day("2026-09-11", 100),
          day("2026-09-12", 100),
        ],
        60
      )
    ).toBe(3);
    expect(longestStreak([], 60)).toBe(0);
  });
});

describe("readingOverview", () => {
  it("summarises today, the streak, the calendar, and pace", async () => {
    const store = memoryStore();
    await store.putReadingDay({
      date: "2026-09-28",
      seconds: 900,
      words: 2400,
      pages: 12,
      bookIds: ["a"],
      updatedAt: 1,
    });
    await store.putReadingDay({
      date: "2026-09-27",
      seconds: 700,
      words: 2000,
      pages: 9,
      bookIds: ["a", "b"],
      updatedAt: 1,
    });
    await store.putReadingDay({
      date: "2026-09-26",
      seconds: 30,
      words: 50,
      pages: 1,
      bookIds: ["c"],
      updatedAt: 1,
    });
    await store.putReadingSession({
      id: "s1",
      bookId: "a",
      startedAt: NOON - DAY,
      endedAt: NOON - DAY + 600_000,
      seconds: 600,
      words: 1500,
      pages: 8,
    });
    await store.putReadingSession({
      id: "s2",
      bookId: "b",
      startedAt: NOON - 2 * DAY,
      endedAt: NOON - 2 * DAY + 30_000,
      seconds: 30,
      words: 200,
      pages: 1,
    });
    await store.putReadingSession({
      id: "s3",
      bookId: "a",
      startedAt: NOON - 10 * DAY,
      endedAt: NOON - 10 * DAY + 600_000,
      seconds: 600,
      words: 6000,
      pages: 20,
    });

    const overview = await readingOverview(store, { now: () => NOON });
    expect(overview.todaySeconds).toBe(900);
    expect(overview.todayWords).toBe(2400);
    expect(overview.todayPages).toBe(12);
    expect(overview.goalSeconds).toBe(DEFAULT_GOAL_SECONDS);
    expect(overview.goalMet).toBe(true);
    expect(overview.streakDays).toBe(2);
    expect(overview.bestStreak).toBe(2);
    expect(overview.days).toHaveLength(28);
    expect(overview.days[27]).toMatchObject({
      date: "2026-09-28",
      seconds: 900,
    });
    expect(overview.days[0]).toMatchObject({ date: "2026-09-01", seconds: 0 });
    expect(overview.totalSeconds).toBe(1630);
    expect(overview.totalWords).toBe(4450);
    expect(overview.booksTouched).toBe(3);
    // Only s1 counts: s2 is too short, s3 is older than a week.
    expect(overview.averageWpm).toBe(150);
    expect(overview.perBook.a).toEqual({
      seconds: 1200,
      words: 7500,
      lastReadAt: NOON - DAY + 600_000,
    });
    expect(overview.perBook.b.seconds).toBe(30);
  });

  it("is quiet for an empty ledger", async () => {
    const overview = await readingOverview(memoryStore(), { now: () => NOON });
    expect(overview.todaySeconds).toBe(0);
    expect(overview.streakDays).toBe(0);
    expect(overview.averageWpm).toBeNull();
    expect(overview.days.every((day) => day.seconds === 0)).toBe(true);
    expect(overview.perBook).toEqual({});
  });

  it("stores a clamped daily goal", async () => {
    const store = memoryStore();
    await setReadingGoal(store, 10);
    expect((await store.getSetting("readingGoal"))?.secondsPerDay).toBe(60);
    await setReadingGoal(store, 100_000);
    expect((await store.getSetting("readingGoal"))?.secondsPerDay).toBe(
      8 * 60 * 60
    );
    await setReadingGoal(store, 1200);
    const overview = await readingOverview(store as LeafletStore, {
      now: () => NOON,
    });
    expect(overview.goalSeconds).toBe(1200);
    expect(clampGoalSeconds(Number.NaN)).toBe(DEFAULT_GOAL_SECONDS);
  });
});
