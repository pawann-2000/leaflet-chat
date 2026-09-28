import { deleteDB, type IDBPDatabase, openDB } from "idb";
import type { LeafletDB } from "@/lib/db/schema";
import {
  type BookRecord,
  DB_NAME,
  DB_VERSION,
  type LeafletStore,
  type SettingKey,
  type SettingsMap,
} from "@/lib/db/types";
import { bookResourceUrl } from "@/lib/epub/urls";
import type { LibraryBook } from "@/lib/types";

let opening: Promise<LeafletStore> | undefined;

/**
 * Open (or reuse) the page's IndexedDB-backed store. The first call creates
 * the object stores; later calls share the same connection.
 */
export function openLeafletStore(): Promise<LeafletStore> {
  opening ??= connect().then(createStore, (error) => {
    opening = undefined;
    throw error;
  });
  return opening;
}

/** Close the shared connection and delete the database. Tests and debugging only. */
export async function resetLeafletStore(): Promise<void> {
  const pending = opening;
  opening = undefined;
  if (pending) {
    try {
      const store = await pending;
      (store as StoreWithConnection).close();
    } catch {
      // The connection never opened; there is nothing to close.
    }
  }
  await deleteDB(DB_NAME);
}

interface StoreWithConnection extends LeafletStore {
  close(): void;
}

function connect(): Promise<IDBPDatabase<LeafletDB>> {
  return openDB<LeafletDB>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains("books")) {
        const books = database.createObjectStore("books", { keyPath: "id" });
        books.createIndex("by-lastOpened", "lastOpenedAt");
      }
      if (!database.objectStoreNames.contains("bookFiles")) {
        database.createObjectStore("bookFiles", { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains("bookRenders")) {
        database.createObjectStore("bookRenders", { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains("progress")) {
        database.createObjectStore("progress", { keyPath: "bookId" });
      }
      if (!database.objectStoreNames.contains("trustedOrigins")) {
        const origins = database.createObjectStore("trustedOrigins", {
          keyPath: "origin",
        });
        origins.createIndex("by-trustedAt", "trustedAt");
      }
      if (!database.objectStoreNames.contains("peers")) {
        database.createObjectStore("peers", { keyPath: "deviceId" });
      }
      if (!database.objectStoreNames.contains("settings")) {
        database.createObjectStore("settings", { keyPath: "key" });
      }
      // v2: the reading ledger. Existing stores are left untouched so a v1
      // database keeps every book, position and setting.
      if (!database.objectStoreNames.contains("readingDays")) {
        database.createObjectStore("readingDays", { keyPath: "date" });
      }
      if (!database.objectStoreNames.contains("readingSessions")) {
        const sessions = database.createObjectStore("readingSessions", {
          keyPath: "id",
        });
        sessions.createIndex("by-book", "bookId");
        sessions.createIndex("by-startedAt", "startedAt");
      }
    },
    blocking(_current, _blocked, event) {
      // A newer version wants to open elsewhere; release our connection so the
      // other page can upgrade, and let the next call reopen.
      (event.target as IDBDatabase | null)?.close();
      opening = undefined;
    },
    terminated() {
      opening = undefined;
    },
  });
}

function toLibraryBook(record: BookRecord): LibraryBook {
  return {
    addedAt: record.addedAt,
    authors: record.authors,
    chapterCount: record.chapterCount,
    coverDataUrl: record.coverPath
      ? bookResourceUrl(record.id, record.coverPath)
      : null,
    fileName: record.fileName,
    id: record.id,
    lastOpenedAt: record.lastOpenedAt,
    size: record.size,
    title: record.title,
  };
}

function createStore(database: IDBPDatabase<LeafletDB>): StoreWithConnection {
  return {
    close() {
      database.close();
    },

    async listBooks() {
      const records = await database.getAll("books");
      return records
        .filter((record) => record.deletedAt === null)
        .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
        .map(toLibraryBook);
    },
    getBook(id) {
      return database.get("books", id);
    },
    allBookRecords() {
      return database.getAll("books");
    },
    async putBook(record) {
      await database.put("books", record);
    },
    async deleteBook(id, deletedAt = Date.now()) {
      const tx = database.transaction(
        ["books", "bookFiles", "bookRenders", "progress"],
        "readwrite"
      );
      const books = tx.objectStore("books");
      const existing = await books.get(id);
      if (existing) {
        await books.put({ ...existing, deletedAt, updatedAt: deletedAt });
      }
      await tx.objectStore("bookFiles").delete(id);
      await tx.objectStore("bookRenders").delete(id);
      await tx.objectStore("progress").delete(id);
      await tx.done;
    },
    async touchBook(id, lastOpenedAt) {
      const tx = database.transaction("books", "readwrite");
      const existing = await tx.store.get(id);
      if (existing) {
        await tx.store.put({ ...existing, lastOpenedAt });
      }
      await tx.done;
    },

    getBookFile(id) {
      return database.get("bookFiles", id);
    },
    async putBookFile(record) {
      await database.put("bookFiles", record);
    },

    getRender(id) {
      return database.get("bookRenders", id);
    },
    async putRender(record) {
      await database.put("bookRenders", record);
    },

    getProgress(bookId) {
      return database.get("progress", bookId);
    },
    allProgress() {
      return database.getAll("progress");
    },
    async putProgress(record) {
      const tx = database.transaction("progress", "readwrite");
      const existing = await tx.store.get(record.bookId);
      const newer = !existing || record.updatedAt > existing.updatedAt;
      if (newer) {
        await tx.store.put(record);
      }
      await tx.done;
      return newer;
    },

    async listTrustedOrigins() {
      const records = await database.getAll("trustedOrigins");
      return records
        .filter((record) => record.deletedAt === null)
        .sort(
          (a, b) =>
            b.trustedAt - a.trustedAt || a.origin.localeCompare(b.origin)
        );
    },
    allTrustedOriginRecords() {
      return database.getAll("trustedOrigins");
    },
    async isOriginTrusted(origin) {
      const record = await database.get("trustedOrigins", origin);
      return record !== undefined && record.deletedAt === null;
    },
    async trustOrigin(origin, now = Date.now()) {
      await database.put("trustedOrigins", {
        origin,
        trustedAt: Math.floor(now / 1000),
        updatedAt: now,
        deletedAt: null,
      });
    },
    async revokeOrigin(origin, now = Date.now()) {
      const tx = database.transaction("trustedOrigins", "readwrite");
      const existing = await tx.store.get(origin);
      if (existing && existing.deletedAt === null) {
        await tx.store.put({ ...existing, deletedAt: now, updatedAt: now });
      }
      await tx.done;
    },
    async revokeAllOrigins(now = Date.now()) {
      const tx = database.transaction("trustedOrigins", "readwrite");
      const records = await tx.store.getAll();
      for (const record of records) {
        if (record.deletedAt === null) {
          await tx.store.put({ ...record, deletedAt: now, updatedAt: now });
        }
      }
      await tx.done;
    },
    async putTrustedOriginRecord(record) {
      const tx = database.transaction("trustedOrigins", "readwrite");
      const existing = await tx.store.get(record.origin);
      const newer = !existing || record.updatedAt > existing.updatedAt;
      if (newer) {
        await tx.store.put(record);
      }
      await tx.done;
      return newer;
    },

    getReadingDay(date) {
      return database.get("readingDays", date);
    },
    async putReadingDay(record) {
      await database.put("readingDays", record);
    },
    async listReadingDays(sinceDate) {
      // Keys are local `YYYY-MM-DD` strings, so a lower bound sorts by day.
      const records = await database.getAll(
        "readingDays",
        IDBKeyRange.lowerBound(sinceDate)
      );
      return records.sort((a, b) => a.date.localeCompare(b.date));
    },
    async putReadingSession(record) {
      await database.put("readingSessions", record);
    },
    async listReadingSessions(bookId) {
      const records =
        bookId === undefined
          ? await database.getAll("readingSessions")
          : await database.getAllFromIndex(
              "readingSessions",
              "by-book",
              bookId
            );
      return records.sort((a, b) => a.startedAt - b.startedAt);
    },

    listPeers() {
      return database.getAll("peers");
    },
    async putPeer(record) {
      await database.put("peers", record);
    },
    async deletePeer(deviceId) {
      await database.delete("peers", deviceId);
    },

    async getSetting<K extends SettingKey>(key: K) {
      const record = await database.get("settings", key);
      return record?.value as SettingsMap[K] | undefined;
    },
    async putSetting<K extends SettingKey>(key: K, value: SettingsMap[K]) {
      await database.put("settings", { key, value });
    },
    async deleteSetting(key) {
      await database.delete("settings", key);
    },
  };
}

export type {
  BookFileRecord,
  BookRecord,
  BookRenderRecord,
  LeafletStore,
  PeerRecord,
  ProgressRecord,
  ReadingDayRecord,
  ReadingSessionRecord,
  TrustedOriginRecord,
} from "@/lib/db/types";
