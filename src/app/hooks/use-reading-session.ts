import { useEffect, useRef, useState } from "react";
import type { ContentLocator } from "@/lib/reader/locator";
import { createReadingSession, type ReadingSession } from "@/lib/reading-sync";
import type { OpenedBook } from "@/lib/types";

/**
 * The per-book notes/room session (Yjs in IndexedDB, optional reading room).
 * Opens when a book opens, closes when it changes. The saved reading
 * position it remembers wins over the coarse chapter progress, so the caller
 * gets a `restore` callback the moment the session is ready.
 */
export function useReadingSession(
  book: OpenedBook | null,
  handlers: {
    onError: (error: unknown) => void;
    /** The session restored a precise position; the caller should navigate there. */
    onRestore: (saved: ContentLocator) => void;
    /** Current reader location, so a fresh session can adopt it. */
    currentLocation: () => ContentLocator | null;
    /** Navigation counter; restoring is skipped if the reader moved meanwhile. */
    navigationKey: () => number;
  }
) {
  const [session, setSession] = useState<ReadingSession | null>(null);
  const [revision, setRevision] = useState(0);
  const sessionRef = useRef<ReadingSession | null>(null);
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    if (!book) {
      sessionRef.current = null;
      setSession(null);
      return;
    }
    let cancelled = false;
    let opened: ReadingSession | null = null;
    const startingNavigation = latest.current.navigationKey();
    setSession(null);
    createReadingSession(
      book.summary.fingerprint,
      [
        ...new Set([
          ...book.chapters.map((item) => item.id),
          ...book.documents.map((item) => item.id),
        ]),
      ],
      () => {
        if (!cancelled) {
          setRevision((value) => value + 1);
        }
      },
      (error) => {
        if (!cancelled) {
          latest.current.onError(error);
        }
      }
    )
      .then((created) => {
        opened = created;
        if (cancelled) {
          created.destroy().catch(latest.current.onError);
          return;
        }
        sessionRef.current = created;
        setSession(created);
        const saved = created.savedLocation;
        if (saved && latest.current.navigationKey() === startingNavigation) {
          latest.current.onRestore(saved);
        } else if (!saved) {
          const current = latest.current.currentLocation();
          if (current) {
            created.saveLocation(current);
          }
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          latest.current.onError(error);
        }
      });
    return () => {
      cancelled = true;
      if (sessionRef.current === opened) {
        sessionRef.current = null;
      }
      opened?.destroy().catch(latest.current.onError);
    };
  }, [book]);

  return { session, sessionRef, revision };
}
