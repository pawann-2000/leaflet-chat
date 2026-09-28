import type { DBSchema } from "idb";
import type {
  BookFileRecord,
  BookRecord,
  BookRenderRecord,
  PeerRecord,
  ProgressRecord,
  ReadingDayRecord,
  ReadingSessionRecord,
  SettingRecord,
  TrustedOriginRecord,
} from "@/lib/db/types";

/**
 * Typed IndexedDB layout shared by the page (`src/lib/db/index.ts`) and the
 * book service worker (`src/sw/book-sw.ts`). Schema upgrades run only on the
 * page; the worker opens the database read-only and never creates stores.
 */
export interface LeafletDB extends DBSchema {
  bookFiles: {
    key: string;
    value: BookFileRecord;
  };
  bookRenders: {
    key: string;
    value: BookRenderRecord;
  };
  books: {
    key: string;
    value: BookRecord;
    indexes: { "by-lastOpened": number };
  };
  peers: {
    key: string;
    value: PeerRecord;
  };
  progress: {
    key: string;
    value: ProgressRecord;
  };
  readingDays: {
    key: string;
    value: ReadingDayRecord;
  };
  readingSessions: {
    key: string;
    value: ReadingSessionRecord;
    indexes: { "by-book": string; "by-startedAt": number };
  };
  settings: {
    key: string;
    value: SettingRecord;
  };
  trustedOrigins: {
    key: string;
    value: TrustedOriginRecord;
    indexes: { "by-trustedAt": number };
  };
}
