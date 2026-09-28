import { type IDBPDatabase, openDB } from "idb";

/**
 * The share-target inbox: a tiny IndexedDB database of its own, written by
 * the service worker when another app shares an EPUB with Leaflet and
 * drained by the page on its next load. Separate from the library database
 * so the worker never has to know (or upgrade) the page's schema.
 */
export const INBOX_DB_NAME = "leaflet-inbox";
export const INBOX_STORE = "files";
const INBOX_VERSION = 1;

export interface InboxRecord {
  blob: Blob;
  name: string;
  receivedAt: number;
  type: string;
}

interface InboxSchema {
  [INBOX_STORE]: { key: number; value: InboxRecord };
}

export function openInbox(): Promise<IDBPDatabase<InboxSchema>> {
  return openDB<InboxSchema>(INBOX_DB_NAME, INBOX_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(INBOX_STORE)) {
        database.createObjectStore(INBOX_STORE, { autoIncrement: true });
      }
    },
  });
}

export async function addToInbox(files: File[]): Promise<number> {
  if (!files.length) {
    return 0;
  }
  const database = await openInbox();
  try {
    const transaction = database.transaction(INBOX_STORE, "readwrite");
    const now = Date.now();
    await Promise.all([
      ...files.map((file) =>
        transaction.store.add({
          blob: file,
          name: file.name,
          type: file.type,
          receivedAt: now,
        })
      ),
      transaction.done,
    ]);
    return files.length;
  } finally {
    database.close();
  }
}
