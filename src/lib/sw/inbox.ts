import { INBOX_STORE, openInbox } from "./inbox-db";

/**
 * Files handed to Leaflet from outside the page:
 *
 * - `takeInboxFiles()` drains EPUBs the service worker stored for the
 *   manifest `share_target` (Android "Share → Leaflet").
 * - `watchLaunchFiles()` receives files opened through the manifest
 *   `file_handlers` ("Open with Leaflet") via the Launch Handler API.
 *
 * Both are no-ops where the underlying APIs are missing.
 */

export const INBOX_QUERY = "inbox";

/** True when the worker redirected here after a share (`/?inbox=1`). */
export function hasInboxHint(search: string = location.search): boolean {
  return new URLSearchParams(search).get(INBOX_QUERY) === "1";
}

export async function takeInboxFiles(): Promise<File[]> {
  if (typeof indexedDB === "undefined") {
    return [];
  }
  let database: Awaited<ReturnType<typeof openInbox>>;
  try {
    database = await openInbox();
  } catch {
    return [];
  }
  try {
    const transaction = database.transaction(INBOX_STORE, "readwrite");
    const records = await transaction.store.getAll();
    await transaction.store.clear();
    await transaction.done;
    return records.map(
      (record) =>
        new File([record.blob], record.name || "shared.epub", {
          type: record.type || "application/epub+zip",
          lastModified: record.receivedAt,
        })
    );
  } finally {
    database.close();
  }
}

interface LaunchParamsLike {
  files?: ReadonlyArray<{ getFile(): Promise<File> }>;
}

interface LaunchQueueLike {
  setConsumer(consumer: (params: LaunchParamsLike) => void): void;
}

export function watchLaunchFiles(
  callback: (files: File[]) => void
): () => void {
  const queue = (globalThis as { launchQueue?: LaunchQueueLike }).launchQueue;
  if (!queue || typeof queue.setConsumer !== "function") {
    return () => undefined;
  }
  let active = true;
  queue.setConsumer((params) => {
    if (!(active && params.files?.length)) {
      return;
    }
    Promise.all(params.files.map((handle) => handle.getFile()))
      .then((files) => {
        if (active && files.length) {
          callback(files);
        }
      })
      .catch(() => undefined);
  });
  return () => {
    active = false;
  };
}
