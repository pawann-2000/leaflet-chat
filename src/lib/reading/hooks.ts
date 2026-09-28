import { useCallback, useEffect, useRef, useState } from "react";
import type { LeafletStore, SpeedReadingPrefs } from "@/lib/db/types";
import { DEFAULT_GOAL_SECONDS, readingOverview, setReadingGoal } from "./stats";
import { startReadingTracker } from "./tracker";
import type { ReadingOverview, ReadingSnapshot, ReadingTracker } from "./types";

export const EMPTY_SNAPSHOT: ReadingSnapshot = {
  active: false,
  elapsed: 0,
  words: 0,
  pages: 0,
  wpm: null,
  todaySeconds: 0,
  goalSeconds: DEFAULT_GOAL_SECONDS,
  goalMet: false,
};

export const DEFAULT_SPEED_READING: SpeedReadingPrefs = { wpm: 300, chunk: 1 };

const ignore = () => undefined;

/**
 * Counts reading time while `bookId` is open. The tracker starts when both
 * arguments are present and flushes to storage when either changes or the
 * component unmounts. `goalJustMet` turns true for the sitting in which
 * today's goal was crossed; call `acknowledgeGoal` after celebrating.
 */
export function useReadingTracker(
  store: LeafletStore | null,
  bookId: string | null
) {
  const tracker = useRef<ReadingTracker | null>(null);
  const [snapshot, setSnapshot] = useState<ReadingSnapshot>(EMPTY_SNAPSHOT);
  const [goalJustMet, setGoalJustMet] = useState(false);

  useEffect(() => {
    if (!(store && bookId)) {
      setSnapshot(EMPTY_SNAPSHOT);
      return;
    }
    let cancelled = false;
    let started: ReadingTracker | null = null;
    let unsubscribe: (() => void) | undefined;
    startReadingTracker(store, bookId)
      .then((created) => {
        if (cancelled) {
          created.stop().catch(ignore);
          return;
        }
        started = created;
        tracker.current = created;
        let previousGoalMet = created.snapshot().goalMet;
        unsubscribe = created.subscribe((next) => {
          setSnapshot(next);
          if (!previousGoalMet && next.goalMet) {
            setGoalJustMet(true);
          }
          previousGoalMet = next.goalMet;
        });
      })
      .catch(ignore);
    return () => {
      cancelled = true;
      unsubscribe?.();
      if (tracker.current === started) {
        tracker.current = null;
      }
      started?.stop().catch(ignore);
    };
  }, [store, bookId]);

  const activity = useCallback(() => tracker.current?.activity(), []);
  const pageTurned = useCallback(
    (words: number) => tracker.current?.pageTurned(words),
    []
  );
  const pause = useCallback(() => tracker.current?.pause(), []);
  const resume = useCallback(() => tracker.current?.resume(), []);
  const acknowledgeGoal = useCallback(() => setGoalJustMet(false), []);

  return {
    snapshot,
    activity,
    pageTurned,
    pause,
    resume,
    goalJustMet,
    acknowledgeGoal,
  };
}

/** Loads the streak/goal overview; bump `refreshKey` to reload. */
export function useReadingOverview(
  store: LeafletStore | null,
  refreshKey: unknown = 0
) {
  const [overview, setOverview] = useState<ReadingOverview | null>(null);

  const refresh = useCallback(async () => {
    if (!store) {
      return;
    }
    try {
      setOverview(await readingOverview(store));
    } catch {
      // Stats are decorative; a storage hiccup must not break the page.
    }
  }, [store]);

  useEffect(() => {
    // `refreshKey` only exists to re-run this effect (after a sitting ends).
    if (refreshKey === Symbol.for("leaflet.never")) {
      return;
    }
    refresh().catch(ignore);
  }, [refresh, refreshKey]);

  const setGoal = useCallback(
    async (seconds: number) => {
      if (!store) {
        return;
      }
      await setReadingGoal(store, seconds);
      await refresh();
    },
    [store, refresh]
  );

  return { overview, refresh, setGoal };
}

/** Speed-reading preferences persisted in settings. */
export function useSpeedReadingPrefs(store: LeafletStore | null) {
  const [prefs, setPrefs] = useState<SpeedReadingPrefs>(DEFAULT_SPEED_READING);

  useEffect(() => {
    if (!store) {
      return;
    }
    let cancelled = false;
    store
      .getSetting("speedReading")
      .then((stored) => {
        if (!cancelled && stored) {
          setPrefs({
            wpm: Number.isFinite(stored.wpm)
              ? stored.wpm
              : DEFAULT_SPEED_READING.wpm,
            chunk: stored.chunk === 2 || stored.chunk === 3 ? stored.chunk : 1,
          });
        }
      })
      .catch(ignore);
    return () => {
      cancelled = true;
    };
  }, [store]);

  const update = useCallback(
    (change: Partial<SpeedReadingPrefs>) => {
      setPrefs((current) => {
        const next = { ...current, ...change };
        store?.putSetting("speedReading", next).catch(ignore);
        return next;
      });
    },
    [store]
  );

  const setWpm = useCallback((wpm: number) => update({ wpm }), [update]);
  const setChunk = useCallback(
    (chunk: 1 | 2 | 3) => update({ chunk }),
    [update]
  );

  return { prefs, setWpm, setChunk };
}
