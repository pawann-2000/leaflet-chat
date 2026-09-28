import type {
  LeafletStore,
  ReadingDayRecord,
  ReadingSessionRecord,
} from "@/lib/db/types";
import {
  DEFAULT_GOAL_SECONDS,
  localDateKey,
  readingGoalSeconds,
  startOfLocalDay,
} from "./stats";
import type { ReadingSnapshot, ReadingTracker } from "./types";

export interface ReadingTrackerOptions {
  clearTimeout?: (handle: unknown) => void;
  document?: Document | null;
  /** Milliseconds between storage flushes while counting. */
  flushEveryMs?: number;
  /** Milliseconds without `activity()` before counting pauses. */
  idleAfterMs?: number;
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
}

interface DayDelta {
  pages: number;
  seconds: number;
  words: number;
}

const TICK_MS = 1000;
/** A single tick never credits more than this; laptops sleeping do not count as reading. */
const MAX_TICK_SECONDS = 5;
const WPM_MIN_SECONDS = 30;

function newDelta(): DayDelta {
  return { seconds: 0, words: 0, pages: 0 };
}

function addDelta(
  target: Map<string, DayDelta>,
  date: string,
  delta: DayDelta
) {
  const current = target.get(date) ?? newDelta();
  current.seconds += delta.seconds;
  current.words += delta.words;
  current.pages += delta.pages;
  target.set(date, current);
}

const ignore = () => undefined;

function defaultDocument(option: Document | null | undefined): Document | null {
  if (option !== undefined) {
    return option;
  }
  return typeof document === "undefined" ? null : document;
}

function sessionId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `sitting-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

class Tracker implements ReadingTracker {
  readonly bookId: string;
  private readonly store: LeafletStore;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly idleAfterMs: number;
  private readonly flushEveryMs: number;
  private readonly document: Document | null;
  private readonly listeners = new Set<(snapshot: ReadingSnapshot) => void>();
  private readonly goalSeconds: number;
  /** Seconds already committed to storage per local day, as far as this tracker knows. */
  private readonly stored = new Map<string, number>();
  private pending = new Map<string, DayDelta>();
  private inflight = new Map<string, DayDelta>();
  private session: ReadingSessionRecord;
  private sessionDirty = false;
  private currentDate: string;
  private elapsed = 0;
  private words = 0;
  private pages = 0;
  private lastActivityAt: number;
  private lastTickAt: number;
  private hidden: boolean;
  private idle = false;
  private manuallyPaused = false;
  private stopped = false;
  private tickTimer: unknown = null;
  private flushTimer: unknown = null;
  private flushing: Promise<void> | null = null;
  private flushAgain = false;

  constructor(
    store: LeafletStore,
    bookId: string,
    goalSeconds: number,
    todaySeconds: number,
    options: ReadingTrackerOptions
  ) {
    this.store = store;
    this.bookId = bookId;
    this.goalSeconds = goalSeconds;
    this.now = options.now ?? (() => Date.now());
    this.setTimer =
      options.setTimeout ??
      ((callback, ms) => globalThis.setTimeout(callback, ms));
    this.clearTimer =
      options.clearTimeout ??
      ((handle) => globalThis.clearTimeout(handle as number));
    this.idleAfterMs = options.idleAfterMs ?? 90_000;
    this.flushEveryMs = options.flushEveryMs ?? 15_000;
    this.document = defaultDocument(options.document);
    const now = this.now();
    this.currentDate = localDateKey(now);
    this.stored.set(this.currentDate, todaySeconds);
    this.session = this.newSession(now);
    this.lastActivityAt = now;
    this.lastTickAt = now;
    this.hidden = this.document?.visibilityState === "hidden";
    this.document?.addEventListener("visibilitychange", this.onVisibility);
    this.document?.defaultView?.addEventListener("pagehide", this.onPageHide);
    this.sync();
  }

  private newSession(startedAt: number): ReadingSessionRecord {
    return {
      id: sessionId(),
      bookId: this.bookId,
      startedAt,
      endedAt: startedAt,
      seconds: 0,
      words: 0,
      pages: 0,
    };
  }

  private get counting(): boolean {
    return !(this.stopped || this.hidden || this.idle || this.manuallyPaused);
  }

  private readonly onVisibility = () => {
    this.hidden = this.document?.visibilityState === "hidden";
    if (!this.hidden) {
      this.lastActivityAt = this.now();
      this.lastTickAt = this.lastActivityAt;
      this.idle = false;
    }
    this.sync();
  };

  private readonly onPageHide = () => {
    this.flushSoon();
  };

  /** Fire-and-forget flush; `flush()` already retries on failure. */
  private flushSoon(): void {
    this.flush().catch(ignore);
  }

  /** Starts or stops the tick loop to match `counting`, then notifies. */
  private sync(): void {
    if (this.counting) {
      if (this.tickTimer === null) {
        this.lastTickAt = this.now();
        this.scheduleTick();
      }
      if (this.flushTimer === null) {
        this.scheduleFlush();
      }
    } else {
      if (this.tickTimer !== null) {
        this.clearTimer(this.tickTimer);
        this.tickTimer = null;
      }
      this.flushSoon();
    }
    this.notify();
  }

  private scheduleTick(): void {
    this.tickTimer = this.setTimer(this.tick, TICK_MS);
  }

  private scheduleFlush(): void {
    this.flushTimer = this.setTimer(() => {
      this.flushTimer = null;
      this.flushSoon();
      if (this.counting) {
        this.scheduleFlush();
      }
    }, this.flushEveryMs);
  }

  private readonly tick = () => {
    this.tickTimer = null;
    if (!this.counting) {
      return;
    }
    const now = this.now();
    const seconds = Math.max(
      0,
      Math.min(MAX_TICK_SECONDS, Math.round((now - this.lastTickAt) / 1000))
    );
    this.lastTickAt = now;
    const date = localDateKey(now);
    if (date !== this.currentDate) {
      this.rollover(now, date);
    }
    if (seconds > 0) {
      this.credit(date, { seconds, words: 0, pages: 0 });
      this.session.endedAt = now;
    }
    if (now - this.lastActivityAt >= this.idleAfterMs) {
      this.idle = true;
      this.sync();
      return;
    }
    this.notify();
    this.scheduleTick();
  };

  /** Midnight passed: close the sitting on yesterday's ledger and open a fresh one. */
  private rollover(now: number, date: string): void {
    this.flushSoon();
    this.session = this.newSession(startOfLocalDay(now));
    this.currentDate = date;
    if (!this.stored.has(date)) {
      this.stored.set(date, 0);
      this.store
        .getReadingDay(date)
        .then((record) => {
          // A flush may have committed first; never lower what we know.
          this.stored.set(
            date,
            Math.max(this.stored.get(date) ?? 0, record?.seconds ?? 0)
          );
        })
        .catch(ignore);
    }
  }

  private credit(date: string, delta: DayDelta): void {
    this.elapsed += delta.seconds;
    this.words += delta.words;
    this.pages += delta.pages;
    addDelta(this.pending, date, delta);
    this.session.seconds += delta.seconds;
    this.session.words += delta.words;
    this.session.pages += delta.pages;
    this.sessionDirty = true;
  }

  private todaySeconds(): number {
    const today = localDateKey(this.now());
    return (
      (this.stored.get(today) ?? 0) +
      (this.inflight.get(today)?.seconds ?? 0) +
      (this.pending.get(today)?.seconds ?? 0)
    );
  }

  snapshot(): ReadingSnapshot {
    const todaySeconds = this.todaySeconds();
    return {
      active: this.counting,
      elapsed: this.elapsed,
      words: this.words,
      pages: this.pages,
      wpm:
        this.elapsed >= WPM_MIN_SECONDS && this.words > 0
          ? Math.round(this.words / (this.elapsed / 60))
          : null,
      todaySeconds,
      goalSeconds: this.goalSeconds,
      goalMet: todaySeconds >= this.goalSeconds,
    };
  }

  private notify(): void {
    if (this.listeners.size === 0) {
      return;
    }
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  subscribe(listener: (snapshot: ReadingSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  activity(): void {
    if (this.stopped) {
      return;
    }
    this.lastActivityAt = this.now();
    if (this.idle) {
      this.idle = false;
      this.lastTickAt = this.lastActivityAt;
      this.sync();
    }
  }

  pageTurned(words: number): void {
    if (this.stopped) {
      return;
    }
    this.activity();
    const safeWords = Number.isFinite(words)
      ? Math.max(0, Math.round(words))
      : 0;
    this.credit(localDateKey(this.now()), {
      seconds: 0,
      words: safeWords,
      pages: 1,
    });
    this.session.endedAt = this.now();
    this.notify();
  }

  pause(): void {
    if (this.stopped || this.manuallyPaused) {
      return;
    }
    this.manuallyPaused = true;
    this.sync();
  }

  resume(): void {
    if (this.stopped || !this.manuallyPaused) {
      return;
    }
    this.manuallyPaused = false;
    this.idle = false;
    this.lastActivityAt = this.now();
    this.sync();
  }

  private flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    if (this.pending.size === 0 && !this.sessionDirty) {
      return Promise.resolve();
    }
    const deltas = this.pending;
    this.pending = new Map();
    this.inflight = deltas;
    const session = this.sessionDirty ? { ...this.session } : null;
    this.sessionDirty = false;
    this.flushing = this.commit(deltas, session)
      .catch(() => {
        // Storage refused (quota, closed connection): keep the credit and
        // retry at the next flush instead of dropping reading time.
        for (const [date, delta] of deltas) {
          addDelta(this.pending, date, delta);
        }
        if (session) {
          this.sessionDirty = true;
        }
      })
      .finally(() => {
        this.inflight = new Map();
        this.flushing = null;
        if (this.flushAgain) {
          this.flushAgain = false;
          this.flushSoon();
        }
      });
    return this.flushing;
  }

  private async commit(
    deltas: Map<string, DayDelta>,
    session: ReadingSessionRecord | null
  ): Promise<void> {
    for (const [date, delta] of deltas) {
      const existing = await this.store.getReadingDay(date);
      const merged: ReadingDayRecord = {
        date,
        seconds: (existing?.seconds ?? 0) + delta.seconds,
        words: (existing?.words ?? 0) + delta.words,
        pages: (existing?.pages ?? 0) + delta.pages,
        bookIds: existing?.bookIds.includes(this.bookId)
          ? existing.bookIds
          : [...(existing?.bookIds ?? []), this.bookId],
        updatedAt: this.now(),
      };
      await this.store.putReadingDay(merged);
      this.stored.set(date, merged.seconds);
    }
    if (
      session &&
      (session.seconds > 0 || session.words > 0 || session.pages > 0)
    ) {
      await this.store.putReadingSession(session);
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      await this.flushing;
      return;
    }
    this.stopped = true;
    if (this.tickTimer !== null) {
      this.clearTimer(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.flushTimer !== null) {
      this.clearTimer(this.flushTimer);
      this.flushTimer = null;
    }
    this.document?.removeEventListener("visibilitychange", this.onVisibility);
    this.document?.defaultView?.removeEventListener(
      "pagehide",
      this.onPageHide
    );
    this.notify();
    this.listeners.clear();
    await this.flush();
    await this.flushing;
  }
}

/**
 * Start counting reading time for `bookId`. Resolves once today's stored
 * total and the daily goal are known, so the first snapshot is accurate.
 */
export async function startReadingTracker(
  store: LeafletStore,
  bookId: string,
  options: ReadingTrackerOptions = {}
): Promise<ReadingTracker> {
  const now = options.now?.() ?? Date.now();
  const [goalSeconds, today] = await Promise.all([
    readingGoalSeconds(store).catch(() => DEFAULT_GOAL_SECONDS),
    store.getReadingDay(localDateKey(now)).catch(() => undefined),
  ]);
  return new Tracker(store, bookId, goalSeconds, today?.seconds ?? 0, options);
}
