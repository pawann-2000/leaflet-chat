import type { ReadingDayRecord } from "@/lib/db/types";

/** Live view of the current sitting plus today's totals. */
export interface ReadingSnapshot {
  /** Whether time is being counted right now (visible, not idle, not paused). */
  active: boolean;
  /** Active seconds in this sitting. */
  elapsed: number;
  goalMet: boolean;
  goalSeconds: number;
  /** Pages turned this sitting. */
  pages: number;
  /** Today's active seconds across every sitting and book. */
  todaySeconds: number;
  /** Words on the pages turned this sitting. */
  words: number;
  /** Words per minute this sitting, once there is enough signal. */
  wpm: number | null;
}

export interface ReadingTracker {
  /**
   * Any reader interaction (page turn, selection, key, scroll). Resets the
   * idle timer and resumes counting after an idle pause. An explicit
   * `pause()` stays in force until `resume()`.
   */
  activity(): void;
  readonly bookId: string;
  /** Words on the page that was just read. Also counts as activity. */
  pageTurned(words: number): void;
  /** Stop counting until `resume()`; the timer ignores activity meanwhile. */
  pause(): void;
  resume(): void;
  snapshot(): ReadingSnapshot;
  /** Flushes the sitting to storage and stops timers. Safe to call twice. */
  stop(): Promise<void>;
  /**
   * Fires with the latest snapshot immediately, then at least once per
   * second while active and after every state change.
   */
  subscribe(listener: (snapshot: ReadingSnapshot) => void): () => void;
}

export interface BookReadingTotals {
  lastReadAt: number;
  seconds: number;
  words: number;
}

export interface ReadingOverview {
  /** Words per minute over the last seven days of sittings, or null with no signal. */
  averageWpm: number | null;
  bestStreak: number;
  booksTouched: number;
  /** The last N local days, oldest first, with zero-filled gaps. */
  days: ReadingDayRecord[];
  goalMet: boolean;
  goalSeconds: number;
  perBook: Record<string, BookReadingTotals>;
  streakDays: number;
  todayPages: number;
  todaySeconds: number;
  todayWords: number;
  totalSeconds: number;
  totalWords: number;
}
