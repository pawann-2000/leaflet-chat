import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localDateKey } from "./stats";
import { memoryStore } from "./testing";
import { startReadingTracker } from "./tracker";
import type { ReadingSnapshot } from "./types";

const BOOK = "b".repeat(64);
const START = new Date(2026, 8, 28, 22, 0, 0).getTime();

function fakeTimers() {
  return {
    now: () => Date.now(),
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    document: null,
  };
}

async function tick(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("reading tracker", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts active seconds and reports today's total including stored time", async () => {
    const store = memoryStore();
    await store.putReadingDay({
      date: localDateKey(START),
      seconds: 600,
      words: 100,
      pages: 2,
      bookIds: ["other"],
      updatedAt: 1,
    });
    const tracker = await startReadingTracker(store, BOOK, fakeTimers());
    const seen: ReadingSnapshot[] = [];
    tracker.subscribe((snapshot) => seen.push(snapshot));
    expect(seen[0]).toMatchObject({
      elapsed: 0,
      todaySeconds: 600,
      active: true,
      goalMet: false,
    });
    await tick(5000);
    const snapshot = tracker.snapshot();
    expect(snapshot.elapsed).toBe(5);
    expect(snapshot.todaySeconds).toBe(605);
    expect(snapshot.wpm).toBeNull();
    expect(seen.length).toBeGreaterThanOrEqual(6);
    await tracker.stop();
    expect(store.days.get(localDateKey(START))).toMatchObject({
      seconds: 605,
      words: 100,
      pages: 2,
      bookIds: ["other", BOOK],
    });
    const [session] = [...store.sessions.values()];
    expect(session).toMatchObject({
      bookId: BOOK,
      seconds: 5,
      startedAt: START,
      endedAt: START + 5000,
    });
  });

  it("pauses after the idle window and resumes on activity", async () => {
    const store = memoryStore();
    const tracker = await startReadingTracker(store, BOOK, {
      ...fakeTimers(),
      idleAfterMs: 3000,
    });
    await tick(3000);
    expect(tracker.snapshot()).toMatchObject({ elapsed: 3, active: false });
    await tick(5000);
    expect(tracker.snapshot().elapsed).toBe(3);
    tracker.activity();
    expect(tracker.snapshot().active).toBe(true);
    await tick(2000);
    expect(tracker.snapshot().elapsed).toBe(5);
    await tracker.stop();
  });

  it("flushes on the interval and keeps credit when a write fails", async () => {
    const store = memoryStore();
    const tracker = await startReadingTracker(store, BOOK, {
      ...fakeTimers(),
      flushEveryMs: 2000,
    });
    store.failNextDayWrite();
    await tick(4000);
    // The first flush failed and retried; nothing was lost in between.
    expect(tracker.snapshot().todaySeconds).toBe(4);
    await tracker.stop();
    expect(store.days.get(localDateKey(START))?.seconds).toBe(4);
    expect([...store.sessions.values()]).toHaveLength(1);
  });

  it("splits a sitting that crosses midnight across two days and two sessions", async () => {
    const store = memoryStore();
    vi.setSystemTime(new Date(2026, 8, 28, 23, 59, 57).getTime());
    const tracker = await startReadingTracker(store, BOOK, fakeTimers());
    await tick(6000);
    await tracker.stop();
    expect(store.days.get("2026-09-28")?.seconds).toBe(2);
    expect(store.days.get("2026-09-29")?.seconds).toBe(4);
    const sessions = [...store.sessions.values()].sort(
      (a, b) => a.startedAt - b.startedAt
    );
    expect(sessions).toHaveLength(2);
    expect(sessions[0].seconds).toBe(2);
    expect(sessions[1]).toMatchObject({
      seconds: 4,
      startedAt: new Date(2026, 8, 29).getTime(),
    });
    expect(tracker.snapshot().elapsed).toBe(6);
  });

  it("credits words and pages and derives words per minute", async () => {
    const store = memoryStore();
    const tracker = await startReadingTracker(store, BOOK, fakeTimers());
    await tick(30_000);
    tracker.pageTurned(250);
    await tick(30_000);
    tracker.pageTurned(250);
    const snapshot = tracker.snapshot();
    expect(snapshot).toMatchObject({ words: 500, pages: 2, elapsed: 60 });
    expect(snapshot.wpm).toBe(500);
    await tracker.stop();
    expect(store.days.get(localDateKey(START))).toMatchObject({
      words: 500,
      pages: 2,
      seconds: 60,
    });
  });

  it("flips goalMet the moment today's seconds cross the goal", async () => {
    const store = memoryStore();
    await store.putSetting("readingGoal", { secondsPerDay: 65 });
    await store.putReadingDay({
      date: localDateKey(START),
      seconds: 60,
      words: 0,
      pages: 0,
      bookIds: [],
      updatedAt: 1,
    });
    const tracker = await startReadingTracker(store, BOOK, fakeTimers());
    const transitions: boolean[] = [];
    tracker.subscribe((snapshot) => transitions.push(snapshot.goalMet));
    await tick(4000);
    expect(tracker.snapshot().goalMet).toBe(false);
    await tick(1000);
    expect(tracker.snapshot()).toMatchObject({
      goalMet: true,
      goalSeconds: 65,
      todaySeconds: 65,
    });
    expect(transitions.indexOf(true)).toBeGreaterThan(0);
    await tracker.stop();
  });

  it("honours explicit pause and resume", async () => {
    const store = memoryStore();
    const tracker = await startReadingTracker(store, BOOK, fakeTimers());
    await tick(2000);
    tracker.pause();
    expect(tracker.snapshot().active).toBe(false);
    tracker.activity();
    await tick(3000);
    expect(tracker.snapshot()).toMatchObject({ elapsed: 2, active: false });
    tracker.resume();
    await tick(1000);
    expect(tracker.snapshot()).toMatchObject({ elapsed: 3, active: true });
    await tracker.stop();
    await tracker.stop();
    expect(store.days.get(localDateKey(START))?.seconds).toBe(3);
  });

  it("pauses while the document is hidden and resumes when visible", async () => {
    const store = memoryStore();
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    const tracker = await startReadingTracker(store, BOOK, {
      ...fakeTimers(),
      document,
    });
    await tick(2000);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(tracker.snapshot().active).toBe(false);
    await tick(5000);
    expect(tracker.snapshot().elapsed).toBe(2);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await tick(1000);
    expect(tracker.snapshot()).toMatchObject({ elapsed: 3, active: true });
    await tracker.stop();
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(tracker.snapshot().elapsed).toBe(3);
  });

  it("never credits more than a few seconds for one tick after a suspended clock", async () => {
    const store = memoryStore();
    const tracker = await startReadingTracker(store, BOOK, fakeTimers());
    await tick(1000);
    // The machine slept: the next timer fires much later in wall-clock time.
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    tracker.activity();
    await tick(1000);
    expect(tracker.snapshot().elapsed).toBeLessThanOrEqual(1 + 5);
    await tracker.stop();
  });
});
