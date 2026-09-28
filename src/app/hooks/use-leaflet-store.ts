import { useEffect, useState } from "react";
import { openLeafletStore } from "@/lib/db";
import type { LeafletStore } from "@/lib/db/types";

/**
 * The IndexedDB store, opened once per page. Reading statistics and speed
 * reading preferences live here on every host (the desktop webview has
 * IndexedDB too); the web host additionally keeps the library in it.
 */
export function useLeafletStore(onError: (error: unknown) => void) {
  const [store, setStore] = useState<LeafletStore | null>(null);
  useEffect(() => {
    let cancelled = false;
    openLeafletStore().then(
      (opened) => {
        if (!cancelled) {
          setStore(opened);
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          onError(error);
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [onError]);
  return store;
}
