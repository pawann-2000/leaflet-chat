import type {
  LeafletStore,
  ReadingDayRecord,
  ReadingSessionRecord,
  SettingKey,
  SettingsMap,
} from "@/lib/db/types";

/**
 * An in-memory store implementing only the reading ledger, so tracker and
 * overview tests run without IndexedDB. Optional hooks let a test make a
 * write fail once to exercise retry paths.
 */
export interface MemoryStore extends LeafletStore {
  readonly days: Map<string, ReadingDayRecord>;
  failNextDayWrite(): void;
  readonly sessions: Map<string, ReadingSessionRecord>;
}

const unsupported = () => Promise.reject(new Error("not in the memory store"));

export function memoryStore(): MemoryStore {
  const days = new Map<string, ReadingDayRecord>();
  const sessions = new Map<string, ReadingSessionRecord>();
  const settings = new Map<SettingKey, unknown>();
  let failDayWrite = false;
  const store: MemoryStore = {
    days,
    sessions,
    failNextDayWrite() {
      failDayWrite = true;
    },
    getReadingDay: (date) => Promise.resolve(days.get(date)),
    putReadingDay(record) {
      if (failDayWrite) {
        failDayWrite = false;
        return Promise.reject(new Error("quota"));
      }
      days.set(record.date, structuredClone(record));
      return Promise.resolve();
    },
    listReadingDays: (since) =>
      Promise.resolve(
        [...days.values()]
          .filter((record) => record.date >= since)
          .sort((a, b) => a.date.localeCompare(b.date))
      ),
    putReadingSession(record) {
      sessions.set(record.id, structuredClone(record));
      return Promise.resolve();
    },
    listReadingSessions: (bookId) =>
      Promise.resolve(
        [...sessions.values()]
          .filter((record) => bookId === undefined || record.bookId === bookId)
          .sort((a, b) => a.startedAt - b.startedAt)
      ),
    getSetting: <K extends SettingKey>(key: K) =>
      Promise.resolve(settings.get(key) as SettingsMap[K] | undefined),
    putSetting: <K extends SettingKey>(key: K, value: SettingsMap[K]) => {
      settings.set(key, value);
      return Promise.resolve();
    },
    deleteSetting(key) {
      settings.delete(key);
      return Promise.resolve();
    },
    allBookRecords: unsupported,
    allProgress: unsupported,
    allTrustedOriginRecords: unsupported,
    deleteBook: unsupported,
    deletePeer: unsupported,
    getBook: unsupported,
    getBookFile: unsupported,
    getProgress: unsupported,
    getRender: unsupported,
    isOriginTrusted: unsupported,
    listBooks: unsupported,
    listPeers: unsupported,
    listTrustedOrigins: unsupported,
    putBook: unsupported,
    putBookFile: unsupported,
    putPeer: unsupported,
    putProgress: unsupported,
    putRender: unsupported,
    putTrustedOriginRecord: unsupported,
    revokeAllOrigins: unsupported,
    revokeOrigin: unsupported,
    touchBook: unsupported,
    trustOrigin: unsupported,
  };
  return store;
}
