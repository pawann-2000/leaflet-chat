import type { ZipEntry } from "@/lib/epub/zip";
import type {
  Chapter,
  ChapterSummary,
  LibraryBook,
  ProviderConfig,
  PublicationDocument,
  ReadingPosition,
  TocEntry,
} from "@/lib/types";

/**
 * IndexedDB schema for the web platform.
 *
 * Every record that takes part in cross-device sync carries `updatedAt`
 * (milliseconds since the epoch, from the writing device's clock) and, when
 * removed, `deletedAt` instead of being physically deleted. Sync merges by
 * last-writer-wins on `updatedAt`; tombstones let a deletion on one device win
 * over a stale copy on another. Physical removal of tombstones is a separate,
 * later concern.
 */

export const DB_NAME = "leaflet";
/** v2 added the reading ledger (`readingDays`, `readingSessions`). */
export const DB_VERSION = 2;

/** Bump when the chapter renderer changes so stored renders are rebuilt. */
export const RENDER_VERSION = 2;

export interface BookRecord {
  addedAt: number;
  authors: string[];
  chapterCount: number;
  /** Archive path of the cover image (served through the book protocol), if any. */
  coverPath: string | null;
  deletedAt: number | null;
  fileName: string;
  /** SHA-256 hex of the EPUB bytes. */
  id: string;
  language: string | null;
  lastOpenedAt: number;
  pageDirection: "default" | "left-to-right" | "right-to-left";
  size: number;
  title: string;
  updatedAt: number;
}

export type ResourceTransform = "none" | "idpf-font" | "unsupported";

export interface ResourceEntry {
  mediaType: string;
  transform: ResourceTransform;
  /** Index into `BookFileRecord.entries`. */
  zipIndex: number;
}

export interface BookFileRecord {
  blob: Blob;
  entries: ZipEntry[];
  /** SHA-1 of the publication identifier, used to reverse IDPF font obfuscation. */
  fontKey: Uint8Array | null;
  id: string;
  /** Manifest-declared renderable resources keyed by absolute archive path ("/EPUB/img.png"). */
  resources: Record<string, ResourceEntry>;
}

export interface NavigationTarget {
  chapterIndex: number | null;
  id: string;
  /** Absolute archive path of the document to render. */
  path: string;
  title: string;
}

export interface BookRenderRecord {
  chapters: Chapter[];
  documents: PublicationDocument[];
  id: string;
  /** Opaque link token -> resolved absolute URL (book protocol URL, http(s), or mailto). */
  links: Record<string, string>;
  /** Ordered EPUB TOC, or the complete linear spine when no TOC is usable. */
  navigation: TocEntry[];
  /** Absolute archive path -> target. */
  navigationTargets: Record<string, NavigationTarget>;
  renderVersion: number;
  /** Readable archive path for each linear spine index. */
  spinePaths: string[];
  summaries: ChapterSummary[];
}

export interface ProgressRecord extends ReadingPosition {
  bookId: string;
  updatedAt: number;
}

export interface TrustedOriginRecord {
  deletedAt: number | null;
  origin: string;
  /** Unix seconds, to match the desktop schema. */
  trustedAt: number;
  updatedAt: number;
}

export interface PeerRecord {
  deviceId: string;
  lastSyncAt: number | null;
  name: string;
  pairedAt: number;
  /** Peer's long-term ECDH P-256 public key (JWK). */
  publicKey: JsonWebKey;
}

export interface DeviceIdentity {
  deviceId: string;
  name: string;
  /** This device's long-term ECDH P-256 key pair (JWK, private key included). */
  privateKey: JsonWebKey;
  publicKey: JsonWebKey;
}

/**
 * One local calendar day of reading, summed across books and sittings.
 * `date` is the device's local `YYYY-MM-DD`; a sitting that crosses midnight
 * is split across two records.
 */
export interface ReadingDayRecord {
  bookIds: string[];
  date: string;
  pages: number;
  seconds: number;
  updatedAt: number;
  words: number;
}

/** One continuous sitting with a book (active time only; idle gaps excluded). */
export interface ReadingSessionRecord {
  bookId: string;
  endedAt: number;
  id: string;
  pages: number;
  seconds: number;
  startedAt: number;
  words: number;
}

export interface ReadingGoal {
  secondsPerDay: number;
}

export interface SpeedReadingPrefs {
  chunk: 1 | 2 | 3;
  wpm: number;
}

export interface SettingsMap {
  device: DeviceIdentity;
  provider: ProviderConfig;
  readingGoal: ReadingGoal;
  speedReading: SpeedReadingPrefs;
  /** Optional WebSocket relay used to exchange WebRTC signaling with paired devices. */
  syncRelayUrl: string;
}

export type SettingKey = keyof SettingsMap;

export interface SettingRecord<K extends SettingKey = SettingKey> {
  key: K;
  value: SettingsMap[K];
}

/** Storage API the web platform and the sync engine share. */
export interface LeafletStore {
  /** All book records including tombstones (sync manifest). */
  allBookRecords(): Promise<BookRecord[]>;
  allProgress(): Promise<ProgressRecord[]>;
  allTrustedOriginRecords(): Promise<TrustedOriginRecord[]>;
  /** Tombstone the book and drop its bytes and render. */
  deleteBook(id: string, deletedAt?: number): Promise<void>;
  deletePeer(deviceId: string): Promise<void>;
  deleteSetting(key: SettingKey): Promise<void>;
  getBook(id: string): Promise<BookRecord | undefined>;

  getBookFile(id: string): Promise<BookFileRecord | undefined>;

  getProgress(bookId: string): Promise<ProgressRecord | undefined>;

  getReadingDay(date: string): Promise<ReadingDayRecord | undefined>;

  getRender(id: string): Promise<BookRenderRecord | undefined>;

  getSetting<K extends SettingKey>(key: K): Promise<SettingsMap[K] | undefined>;
  isOriginTrusted(origin: string): Promise<boolean>;
  /** Books that are not tombstoned, newest `lastOpenedAt` first. */
  listBooks(): Promise<LibraryBook[]>;

  listPeers(): Promise<PeerRecord[]>;

  /** Day records with `date >= sinceDate`, oldest first. */
  listReadingDays(sinceDate: string): Promise<ReadingDayRecord[]>;
  /** Sittings, oldest first; filtered to one book when `bookId` is given. */
  listReadingSessions(bookId?: string): Promise<ReadingSessionRecord[]>;

  /** Live (non-tombstoned) origins, newest first. */
  listTrustedOrigins(): Promise<TrustedOriginRecord[]>;
  putBook(record: BookRecord): Promise<void>;
  putBookFile(record: BookFileRecord): Promise<void>;
  putPeer(record: PeerRecord): Promise<void>;
  /** Writes only when `record.updatedAt` is newer than what is stored. */
  putProgress(record: ProgressRecord): Promise<boolean>;
  putReadingDay(record: ReadingDayRecord): Promise<void>;
  putReadingSession(record: ReadingSessionRecord): Promise<void>;
  putRender(record: BookRenderRecord): Promise<void>;
  putSetting<K extends SettingKey>(
    key: K,
    value: SettingsMap[K]
  ): Promise<void>;
  /** Writes only when `record.updatedAt` is newer than what is stored. */
  putTrustedOriginRecord(record: TrustedOriginRecord): Promise<boolean>;
  revokeAllOrigins(now?: number): Promise<void>;
  revokeOrigin(origin: string, now?: number): Promise<void>;
  touchBook(id: string, lastOpenedAt: number): Promise<void>;
  trustOrigin(origin: string, now?: number): Promise<void>;
}
