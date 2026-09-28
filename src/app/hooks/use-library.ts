import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryProgress } from "@/features/library/library-home";
import type { Platform } from "@/lib/platform";
import type { StoredProgress } from "@/lib/platform/types";
import { takeInboxFiles, watchLaunchFiles } from "@/lib/sw/inbox";
import type { LibraryBook, OpenedPublication } from "@/lib/types";

export interface LibraryState {
  books: LibraryBook[];
  busy: boolean;
  /** True while a file is being dragged over the window. */
  dragging: boolean;
  importBook: () => Promise<void>;
  /** True while a book is being opened or imported. */
  loading: boolean;
  openFile: (file: File) => Promise<void>;
  openFromShelf: (id: string) => Promise<void>;
  progress: Record<string, LibraryProgress>;
  refresh: () => Promise<void>;
  removeFromShelf: (book: LibraryBook) => Promise<void>;
}

function percentOf(
  book: LibraryBook,
  position: { chapterIndex: number; progress: number }
): number {
  const chapters = Math.max(1, book.chapterCount);
  const value = ((position.chapterIndex + position.progress) / chapters) * 100;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Everything about the on-device shelf: the list, per-book progress, import
 * paths (picker, drag-and-drop, shared/launched files) and removal. Opening a
 * publication is reported through `onOpened`; the caller owns reader state.
 */
export function useLibrary(
  host: Platform,
  onOpened: (publication: OpenedPublication) => Promise<void>,
  onError: (error: unknown) => void,
  onRemoved: (id: string) => void
): LibraryState {
  const [books, setBooks] = useState<LibraryBook[]>([]);
  const [progress, setProgress] = useState<Record<string, LibraryProgress>>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const loadingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!host.listLibrary) {
      return;
    }
    setBusy(true);
    try {
      const [list, positions] = await Promise.all([
        host.listLibrary(),
        host.listProgress?.() ??
          Promise.resolve<Record<string, StoredProgress>>({}),
      ]);
      setBooks(list);
      const next: Record<string, LibraryProgress> = {};
      for (const book of list) {
        const position = positions[book.id];
        if (position) {
          next[book.id] = {
            chapterIndex: position.chapterIndex,
            progress: position.progress,
            percent: percentOf(book, position),
            lastReadAt: position.updatedAt,
          };
        }
      }
      setProgress(next);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }, [host, onError]);

  const withLoading = useCallback(
    async (task: () => Promise<OpenedPublication | null>) => {
      if (loadingRef.current) {
        return;
      }
      loadingRef.current = true;
      setLoading(true);
      try {
        const publication = await task();
        if (publication) {
          await onOpened(publication);
        }
      } catch (error) {
        onError(error);
      } finally {
        loadingRef.current = false;
        setLoading(false);
      }
    },
    [onOpened, onError]
  );

  const importBook = useCallback(
    () => withLoading(() => host.chooseAndOpenBook()),
    [host, withLoading]
  );
  const openFromShelf = useCallback(
    (id: string) =>
      withLoading(() =>
        host.openLibraryBook ? host.openLibraryBook(id) : Promise.resolve(null)
      ),
    [host, withLoading]
  );
  const openFile = useCallback(
    (file: File) =>
      withLoading(() =>
        host.openBookFile ? host.openBookFile(file) : Promise.resolve(null)
      ),
    [host, withLoading]
  );

  const removeFromShelf = useCallback(
    async (book: LibraryBook) => {
      if (!host.removeLibraryBook) {
        return;
      }
      try {
        await host.removeLibraryBook(book.id);
        onRemoved(book.id);
        await refresh();
      } catch (error) {
        onError(error);
      }
    },
    [host, onError, onRemoved, refresh]
  );

  // Dropping an EPUB anywhere on the page adds it to the library (web only).
  const openDropped = useRef(openFile);
  openDropped.current = openFile;
  useEffect(() => {
    if (!host.openBookFile) {
      return;
    }
    const over = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) {
        event.preventDefault();
        setDragging(true);
      }
    };
    const leave = (event: DragEvent) => {
      if (event.relatedTarget === null) {
        setDragging(false);
      }
    };
    const drop = (event: DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer?.files?.[0];
      if (file) {
        openDropped.current(file);
      }
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [host.openBookFile]);

  // Files shared to the installed app ("Open with Leaflet") or launched by the OS.
  useEffect(() => {
    if (!host.openBookFile) {
      return;
    }
    let cancelled = false;
    takeInboxFiles()
      .then((files) => {
        if (!cancelled && files[0]) {
          openDropped.current(files[0]);
        }
      })
      .catch(() => undefined);
    const stop = watchLaunchFiles((files) => {
      if (files[0]) {
        openDropped.current(files[0]);
      }
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [host.openBookFile]);

  return {
    books,
    busy,
    progress,
    refresh,
    importBook,
    openFromShelf,
    openFile,
    removeFromShelf,
    dragging,
    loading,
  };
}
