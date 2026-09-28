/**
 * Wire format on the data channel.
 *
 * Text frames carry one JSON object with a `t` discriminator. Binary frames
 * carry one 16 KiB book chunk prefixed by a 4-byte big-endian sequence
 * number. Everything that arrives is parsed and bounds-checked here before the
 * protocol sees it; the peer is not trusted just because it is paired.
 */
import type {
  BookRecord,
  ProgressRecord,
  TrustedOriginRecord,
} from "@/lib/db/types";
import { SyncError } from "./errors";
import type { SyncSummary } from "./types";

export const CHUNK_SIZE = 16 * 1024;
export const MAX_BOOK_BYTES = 512 * 1024 * 1024;
/** Keeps every text frame comfortably under the 16 KiB cross-browser limit. */
export const RECORD_BATCH = 32;
export const MANIFEST_BATCH = 64;
const MAX_TEXT_FRAME = 64 * 1024;
const MAX_TIMESTAMP = 1e14;
const MAX_TITLE = 400;
const MAX_STRING = 2048;
const BOOK_ID = /^[0-9a-f]{64}$/u;

export interface BookManifestItem {
  deletedAt: number | null;
  id: string;
  size: number;
  title: string;
  updatedAt: number;
}

export interface ProgressManifestItem {
  bookId: string;
  updatedAt: number;
}

export interface TrustedManifestItem {
  deletedAt: number | null;
  origin: string;
  updatedAt: number;
}

export interface Manifest {
  books: BookManifestItem[];
  progress: ProgressManifestItem[];
  trusted: TrustedManifestItem[];
}

export type SyncMessage =
  | { t: "hello"; deviceId: string; name: string; sas: string }
  | { t: "sas-ok" }
  | { t: "manifest-begin" }
  | { t: "manifest-books"; items: BookManifestItem[] }
  | { t: "manifest-progress"; items: ProgressManifestItem[] }
  | { t: "manifest-trusted"; items: TrustedManifestItem[] }
  | { t: "manifest-end" }
  | { t: "progress"; items: ProgressRecord[] }
  | { t: "trusted"; items: TrustedOriginRecord[] }
  | { t: "book-record"; record: BookRecord }
  | { t: "want-book"; id: string }
  | { t: "requests-done" }
  | {
      t: "book-begin";
      chunkCount: number;
      fileName: string;
      id: string;
      record: BookRecord;
      size: number;
    }
  | { t: "book-end"; id: string }
  | { t: "book-unavailable"; id: string }
  | { t: "done"; summary: SyncSummary }
  | { t: "abort"; reason: string };

function bad(detail: string): SyncError {
  return new SyncError(
    "bad_message",
    `The other device sent invalid data (${detail}).`
  );
}

function obj(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw bad(field);
  }
  return value as Record<string, unknown>;
}

function str(value: unknown, field: string, max = MAX_STRING, min = 1): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw bad(field);
  }
  return value;
}

function nullableStr(
  value: unknown,
  field: string,
  max = MAX_STRING
): string | null {
  return value === null || value === undefined
    ? null
    : str(value, field, max, 0);
}

function num(
  value: unknown,
  field: string,
  { min = 0, max = MAX_TIMESTAMP, integer = false } = {}
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    throw bad(field);
  }
  return value;
}

function nullableNum(value: unknown, field: string): number | null {
  return value === null || value === undefined ? null : num(value, field);
}

function bookId(value: unknown, field = "id"): string {
  const id = str(value, field, 64, 64);
  if (!BOOK_ID.test(id)) {
    throw bad(field);
  }
  return id;
}

function list<T>(
  value: unknown,
  field: string,
  max: number,
  map: (item: unknown) => T
): T[] {
  if (!Array.isArray(value) || value.length > max) {
    throw bad(field);
  }
  return value.map(map);
}

export function validateBookRecord(value: unknown): BookRecord {
  const o = obj(value, "record");
  const direction = o.pageDirection;
  if (
    direction !== "default" &&
    direction !== "left-to-right" &&
    direction !== "right-to-left"
  ) {
    throw bad("pageDirection");
  }
  return {
    addedAt: num(o.addedAt, "addedAt"),
    authors: list(o.authors, "authors", 200, (item) =>
      str(item, "author", 500, 0)
    ),
    chapterCount: num(o.chapterCount, "chapterCount", {
      max: 100_000,
      integer: true,
    }),
    coverPath: nullableStr(o.coverPath, "coverPath"),
    deletedAt: nullableNum(o.deletedAt, "deletedAt"),
    fileName: str(o.fileName, "fileName", 255),
    id: bookId(o.id),
    language: nullableStr(o.language, "language", 64),
    lastOpenedAt: num(o.lastOpenedAt, "lastOpenedAt"),
    pageDirection: direction,
    size: num(o.size, "size", { max: MAX_BOOK_BYTES, integer: true }),
    title: str(o.title, "title", 2000, 0),
    updatedAt: num(o.updatedAt, "updatedAt"),
  };
}

export function validateProgressRecord(value: unknown): ProgressRecord {
  const o = obj(value, "progress");
  return {
    bookId: bookId(o.bookId, "bookId"),
    chapterIndex: num(o.chapterIndex, "chapterIndex", {
      max: 100_000,
      integer: true,
    }),
    progress: num(o.progress, "progress", { max: 1 }),
    updatedAt: num(o.updatedAt, "updatedAt"),
  };
}

function origin(value: unknown): string {
  const text = str(value, "origin", 1024);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw bad("origin");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.origin !== text
  ) {
    throw bad("origin");
  }
  return text;
}

export function validateTrustedOriginRecord(
  value: unknown
): TrustedOriginRecord {
  const o = obj(value, "trusted");
  return {
    deletedAt: nullableNum(o.deletedAt, "deletedAt"),
    origin: origin(o.origin),
    trustedAt: num(o.trustedAt, "trustedAt"),
    updatedAt: num(o.updatedAt, "updatedAt"),
  };
}

function bookManifestItem(value: unknown): BookManifestItem {
  const o = obj(value, "book");
  return {
    deletedAt: nullableNum(o.deletedAt, "deletedAt"),
    id: bookId(o.id),
    size: num(o.size, "size", { max: MAX_BOOK_BYTES, integer: true }),
    title: str(o.title, "title", MAX_TITLE, 0),
    updatedAt: num(o.updatedAt, "updatedAt"),
  };
}

function progressManifestItem(value: unknown): ProgressManifestItem {
  const o = obj(value, "progress");
  return {
    bookId: bookId(o.bookId, "bookId"),
    updatedAt: num(o.updatedAt, "updatedAt"),
  };
}

function trustedManifestItem(value: unknown): TrustedManifestItem {
  const o = obj(value, "trusted");
  return {
    deletedAt: nullableNum(o.deletedAt, "deletedAt"),
    origin: origin(o.origin),
    updatedAt: num(o.updatedAt, "updatedAt"),
  };
}

function summary(value: unknown): SyncSummary {
  const o = obj(value, "summary");
  const count = (field: keyof SyncSummary) =>
    num(o[field], field, { max: 1_000_000, integer: true });
  return {
    booksReceived: count("booksReceived"),
    booksSent: count("booksSent"),
    progressReceived: count("progressReceived"),
    progressSent: count("progressSent"),
    trustedReceived: count("trustedReceived"),
    trustedSent: count("trustedSent"),
  };
}

export function encodeMessage(message: SyncMessage): string {
  return JSON.stringify(message);
}

export function parseMessage(text: string): SyncMessage {
  if (text.length > MAX_TEXT_FRAME) {
    throw bad("frame too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw bad("not JSON");
  }
  const o = obj(parsed, "message");
  const t = o.t;
  switch (t) {
    case "hello":
      return {
        t,
        deviceId: str(o.deviceId, "deviceId", 128),
        name: str(o.name, "name", 120),
        sas: str(o.sas, "sas", 6, 6),
      };
    case "sas-ok":
    case "manifest-begin":
    case "manifest-end":
    case "requests-done":
      return { t };
    case "manifest-books":
      return {
        t,
        items: list(o.items, "items", MANIFEST_BATCH, bookManifestItem),
      };
    case "manifest-progress":
      return {
        t,
        items: list(o.items, "items", MANIFEST_BATCH, progressManifestItem),
      };
    case "manifest-trusted":
      return {
        t,
        items: list(o.items, "items", MANIFEST_BATCH, trustedManifestItem),
      };
    case "progress":
      return {
        t,
        items: list(o.items, "items", RECORD_BATCH, validateProgressRecord),
      };
    case "trusted":
      return {
        t,
        items: list(
          o.items,
          "items",
          RECORD_BATCH,
          validateTrustedOriginRecord
        ),
      };
    case "book-record":
      return { t, record: validateBookRecord(o.record) };
    case "want-book":
    case "book-end":
    case "book-unavailable":
      return { t, id: bookId(o.id) };
    case "book-begin": {
      const size = num(o.size, "size", { max: MAX_BOOK_BYTES, integer: true });
      const chunkCount = num(o.chunkCount, "chunkCount", {
        max: MAX_BOOK_BYTES / CHUNK_SIZE + 1,
        integer: true,
      });
      if (chunkCount !== Math.ceil(size / CHUNK_SIZE)) {
        throw bad("chunkCount");
      }
      return {
        t,
        id: bookId(o.id),
        fileName: str(o.fileName, "fileName", 255),
        size,
        chunkCount,
        record: validateBookRecord(o.record),
      };
    }
    case "done":
      return { t, summary: summary(o.summary) };
    case "abort":
      return { t, reason: str(o.reason, "reason", 500, 0) };
    default:
      throw bad("unknown type");
  }
}

export function frameChunk(seq: number, data: Uint8Array): ArrayBuffer {
  if (data.length > CHUNK_SIZE) {
    throw new SyncError(
      "chunk_too_large",
      "Internal error: chunk exceeds the frame size."
    );
  }
  const frame = new Uint8Array(4 + data.length);
  new DataView(frame.buffer).setUint32(0, seq, false);
  frame.set(data, 4);
  return frame.buffer;
}

export function parseChunk(buffer: ArrayBuffer): {
  data: Uint8Array;
  seq: number;
} {
  if (buffer.byteLength < 4 || buffer.byteLength > CHUNK_SIZE + 4) {
    throw bad("chunk frame");
  }
  const seq = new DataView(buffer).getUint32(0, false);
  return { seq, data: new Uint8Array(buffer, 4) };
}
