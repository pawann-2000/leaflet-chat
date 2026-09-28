/**
 * Trust boundary for everything a peer can send about a book: annotation
 * records inside Yjs updates, presence frames, and the chunk framing that
 * carries large updates through the relay's 64 KiB frames.
 *
 * Nothing here talks to the network. Every function validates before it
 * mutates, and `applyPeerUpdate` rehearses an update on a throwaway document
 * so a rejected update leaves the real one untouched.
 */
import {
  applyUpdate,
  ContentAny,
  ContentDeleted,
  Doc,
  decodeUpdate,
  encodeStateAsUpdate,
  Item,
} from "yjs";
import type { Annotation, AnnotationAuthor, ContentLocator } from "./types";

export type ShareRole = "read" | "annotate";
export const MAX_QUOTE = 16_000;
export const MAX_COMMENT = 8000;
export const MAX_NAME = 40;
export const MAX_TITLE = 400;
export const MAX_AUTHOR_ID = 64;
/** Kept for the previous notes drawer; room codes are 14 characters. */
export const MAX_CODE_LENGTH = 64;
// These limits apply to collaboration metadata, never EPUB file size. Fail visibly at a limit.
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
export const MAX_ANNOTATIONS = 5000;
// A map record is one Yjs item. Reserve history room while bounding integration work.
export const MAX_UPDATE_STRUCTS = MAX_ANNOTATIONS * 4;
export const MESSAGE_BURST = 32;
export const MESSAGES_PER_SECOND = 8;
export const MAX_FRAME_BYTES = 16 * 1024;
export const CHUNK_HEADER_BYTES = 18;
export const CHUNK_BYTES = MAX_FRAME_BYTES - CHUNK_HEADER_BYTES;
export const MAX_STATE_VECTOR_BYTES = 128 * 1024;
/** First byte of a `notes` frame. */
export const NOTES_UPDATE = 1;
export const NOTES_STATE = 3;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BOOK = /^[0-9a-f]{64}$/u;
const COLOR = /^#[0-9a-f]{6}$/iu;
const WHITESPACE = /\s+/gu;

export function invalid(
  message = "The other device sent invalid reading data."
): Error {
  return new Error(message);
}

function object(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid();
  }
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key))) {
    throw invalid();
  }
  return result;
}

function offset(value: unknown): number {
  // EPUB entries are capped at 64 MiB by the importer. This bounds malformed
  // locators while allowing the largest chapter the app accepts.
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 64 * 1024 * 1024
  ) {
    throw invalid();
  }
  return value;
}

function boundedString(value: unknown, max: number, min = 1): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw invalid();
  }
  return value;
}

export function normalizeReaderName(name: string): string {
  const trimmed = name.replace(WHITESPACE, " ").trim().slice(0, MAX_NAME);
  return trimmed || "Reader";
}

export function validateLocator(
  value: unknown,
  chapterIds: ReadonlySet<string>
): ContentLocator {
  const entry = object(value, ["chapterId", "start", "end", "quote"]);
  if (typeof entry.chapterId !== "string" || !chapterIds.has(entry.chapterId)) {
    throw invalid(
      "This reading position belongs to a different chapter or book."
    );
  }
  if (typeof entry.quote !== "string" || entry.quote.length > MAX_QUOTE) {
    throw invalid();
  }
  const start = offset(entry.start);
  const end = offset(entry.end);
  if (end < start) {
    throw invalid("This reading selection ends before it starts.");
  }
  return {
    chapterId: entry.chapterId,
    start,
    end,
    quote: entry.quote,
  };
}

export function validateAuthor(value: unknown): AnnotationAuthor {
  const entry = object(value, ["id", "name", "color"]);
  const color = boundedString(entry.color, 7, 7);
  if (!COLOR.test(color)) {
    throw invalid();
  }
  return {
    id: boundedString(entry.id, MAX_AUTHOR_ID),
    name: boundedString(entry.name, MAX_NAME),
    color: color.toLowerCase(),
  };
}

export function validateAnnotation(
  value: unknown,
  chapterIds: ReadonlySet<string>
): Annotation {
  const entry = object(value, [
    "id",
    "kind",
    "locator",
    "text",
    "createdAt",
    "author",
  ]);
  if (typeof entry.id !== "string" || !UUID.test(entry.id)) {
    throw invalid();
  }
  if (
    entry.kind !== "comment" &&
    entry.kind !== "highlight" &&
    entry.kind !== "bookmark"
  ) {
    throw invalid();
  }
  if (typeof entry.text !== "string" || entry.text.length > MAX_COMMENT) {
    throw invalid();
  }
  if (entry.kind === "comment" && !entry.text.trim()) {
    throw invalid("Write a comment before saving it.");
  }
  if (entry.kind !== "comment" && entry.text !== "") {
    throw invalid();
  }
  if (
    typeof entry.createdAt !== "number" ||
    !Number.isSafeInteger(entry.createdAt) ||
    entry.createdAt < 0 ||
    entry.createdAt > 8.64e15
  ) {
    throw invalid();
  }
  const locator = validateLocator(entry.locator, chapterIds);
  if (entry.kind === "bookmark" && locator.start !== locator.end) {
    throw invalid("A bookmark must point to one reading position.");
  }
  if (
    entry.kind !== "bookmark" &&
    (locator.start === locator.end || !locator.quote)
  ) {
    throw invalid("Select text in the book first.");
  }
  const annotation: Annotation = {
    id: entry.id,
    kind: entry.kind,
    locator,
    text: entry.text,
    createdAt: entry.createdAt,
  };
  if (entry.author !== undefined) {
    annotation.author = validateAuthor(entry.author);
  }
  return annotation;
}

export function readAnnotations(
  doc: Doc,
  chapterIds: ReadonlySet<string>
): Annotation[] {
  if ([...doc.share.keys()].some((name) => name !== "annotations")) {
    throw invalid();
  }
  const notes = doc.getMap<unknown>("annotations");
  if (notes._start !== null) {
    throw invalid("Shared annotations must be a keyed collection.");
  }
  if (notes.size > MAX_ANNOTATIONS) {
    throw invalid(`This book exceeds the ${MAX_ANNOTATIONS} annotation limit.`);
  }
  const annotations: Annotation[] = [];
  notes.forEach((value, id) => {
    const note = validateAnnotation(value, chapterIds);
    if (note.id !== id) {
      throw invalid();
    }
    annotations.push(note);
  });
  // Missing causal dependencies are rejected instead of retaining invisible, unvalidated structs.
  if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) {
    throw invalid("The sync update is incomplete. Disconnect and pair again.");
  }
  return annotations.sort(
    (left, right) =>
      left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  );
}

/** Refilled only by incoming work; there is no timer or network polling while idle. */
export class MessageBudget {
  private tokens = MESSAGE_BURST;
  private last: number;
  private readonly now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
    this.last = now();
  }

  consume(): void {
    const current = this.now();
    if (!Number.isFinite(current)) {
      throw invalid();
    }
    const elapsed = Math.max(0, current - this.last);
    this.last = Math.max(this.last, current);
    this.tokens = Math.min(
      MESSAGE_BURST,
      this.tokens + (elapsed * MESSAGES_PER_SECOND) / 1000
    );
    if (this.tokens < 1) {
      throw invalid(
        `A reader exceeded the sync message limit: burst ${MESSAGE_BURST}, then ${MESSAGES_PER_SECOND} messages per second.`
      );
    }
    this.tokens -= 1;
  }
}

/** Decode is byte-bounded but not sandboxed; see docs/ROOMS.md for the remaining decoder boundary. */
export function validateUpdateComplexity(
  update: Uint8Array,
  chapterIds: ReadonlySet<string>
): void {
  if (update.byteLength > MAX_DOCUMENT_BYTES) {
    throw invalid("The annotation update is too large to sync safely.");
  }
  const decoded = decodeUpdate(update);
  let entries = decoded.structs.length;
  for (const ranges of decoded.ds.clients.values()) {
    entries += ranges.length;
  }
  if (entries > MAX_UPDATE_STRUCTS) {
    throw invalid(
      "The annotation history exceeds the supported sync complexity limit."
    );
  }
  for (const struct of decoded.structs) {
    if (
      !Number.isSafeInteger(struct.length) ||
      struct.length < 1 ||
      !Number.isSafeInteger(struct.id.clock + struct.length)
    ) {
      throw invalid();
    }
    if (!(struct instanceof Item)) {
      continue;
    }
    if (struct.content instanceof ContentDeleted) {
      continue;
    }
    // This feature stores immutable JSON annotation records, never shared text, XML, binary or subdocuments.
    if (
      !(struct.content instanceof ContentAny) ||
      struct.length !== 1 ||
      struct.parentSub === null
    ) {
      throw invalid("The sync update contains unsupported shared content.");
    }
    const annotation = validateAnnotation(
      struct.content.getContent()[0],
      chapterIds
    );
    // Check the encoded map key, including values hidden by Yjs conflicts.
    // Validating only the visible map leaves a dormant invalid value behind.
    if (struct.parentSub !== annotation.id) {
      throw invalid();
    }
  }
}

/** The caller derives canWrite from the room policy, never from a field in a peer frame. */
export function applyPeerUpdate(
  doc: Doc,
  update: Uint8Array,
  canWrite: boolean,
  chapterIds: ReadonlySet<string>,
  origin: unknown
): void {
  if (!canWrite) {
    throw invalid("Read-only readers cannot change shared annotations.");
  }
  validateUpdateComplexity(update, chapterIds);
  const candidate = new Doc();
  try {
    applyUpdate(candidate, encodeStateAsUpdate(doc));
    applyUpdate(candidate, update);
    readAnnotations(candidate, chapterIds);
    validateUpdateComplexity(encodeStateAsUpdate(candidate), chapterIds);
    applyUpdate(doc, update, origin);
  } finally {
    candidate.destroy();
  }
}

// ---------------------------------------------------------------------------
// Presence frames (JSON on the `presence` channel)

export type PresenceFrame =
  | {
      t: "hello";
      name: string;
      color: string;
      fingerprint: string;
      title: string;
      readerId: string;
    }
  | { t: "location"; locator: ContentLocator }
  | { t: "bye" };

export function parsePresenceFrame(
  value: unknown,
  chapterIds: ReadonlySet<string>
): PresenceFrame {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid();
  }
  const type = (value as Record<string, unknown>).t;
  if (type === "hello") {
    const entry = object(value, [
      "t",
      "v",
      "name",
      "color",
      "fingerprint",
      "title",
      "readerId",
    ]);
    if (entry.v !== 1) {
      throw invalid("A reader is using an incompatible version of Leaflet.");
    }
    const author = validateAuthor({
      id: entry.readerId,
      name: entry.name,
      color: entry.color,
    });
    const fingerprint = boundedString(entry.fingerprint, 64, 64);
    if (!BOOK.test(fingerprint)) {
      throw invalid();
    }
    return {
      t: "hello",
      name: author.name,
      color: author.color,
      readerId: author.id,
      fingerprint,
      title: boundedString(entry.title, MAX_TITLE, 0),
    };
  }
  if (type === "location") {
    const entry = object(value, ["t", "locator"]);
    return {
      t: "location",
      locator: validateLocator(entry.locator, chapterIds),
    };
  }
  if (type === "bye") {
    object(value, ["t"]);
    return { t: "bye" };
  }
  throw invalid();
}

// ---------------------------------------------------------------------------
// Chunk framing for the `notes` channel

export function encodeChunks(
  update: Uint8Array,
  transferId: number,
  frameType = NOTES_UPDATE
): ArrayBuffer[] {
  if (!update.byteLength || update.byteLength > MAX_DOCUMENT_BYTES) {
    throw invalid("The annotation update is too large to sync safely.");
  }
  const total = Math.ceil(update.byteLength / CHUNK_BYTES);
  const result: ArrayBuffer[] = [];
  for (let index = 0; index < total; index += 1) {
    const payload = update.subarray(
      index * CHUNK_BYTES,
      (index + 1) * CHUNK_BYTES
    );
    const frame = new ArrayBuffer(CHUNK_HEADER_BYTES + payload.byteLength);
    const header = new DataView(frame);
    header.setUint8(0, frameType);
    header.setUint8(1, 1);
    header.setUint32(2, transferId);
    header.setUint32(6, index);
    header.setUint32(10, total);
    header.setUint32(14, update.byteLength);
    new Uint8Array(frame, CHUNK_HEADER_BYTES).set(payload);
    result.push(frame);
  }
  return result;
}

export class UpdateAssembler {
  private incoming: {
    id: number;
    total: number;
    size: number;
    index: number;
    received: number;
    bytes: Uint8Array;
  } | null = null;
  private readonly frameType: number;
  private readonly byteLimit: number;

  constructor(frameType = NOTES_UPDATE, byteLimit = MAX_DOCUMENT_BYTES) {
    this.frameType = frameType;
    this.byteLimit = byteLimit;
  }

  /** Permission is checked before allocation, parsing, or Yjs decode. */
  receive(frame: ArrayBuffer, canWrite: boolean): Uint8Array | null {
    if (!canWrite) {
      throw invalid("Read-only readers cannot change shared annotations.");
    }
    if (
      frame.byteLength <= CHUNK_HEADER_BYTES ||
      frame.byteLength > MAX_FRAME_BYTES
    ) {
      throw invalid();
    }
    const header = new DataView(frame);
    const id = header.getUint32(2);
    const index = header.getUint32(6);
    const total = header.getUint32(10);
    const size = header.getUint32(14);
    if (
      header.getUint8(0) !== this.frameType ||
      header.getUint8(1) !== 1 ||
      size < 1 ||
      size > this.byteLimit ||
      total !== Math.ceil(size / CHUNK_BYTES) ||
      index >= total
    ) {
      throw invalid();
    }
    const payload = new Uint8Array(frame, CHUNK_HEADER_BYTES);
    const expectedLength =
      index === total - 1 ? size - index * CHUNK_BYTES : CHUNK_BYTES;
    if (payload.byteLength !== expectedLength) {
      throw invalid();
    }
    if (!this.incoming) {
      if (index !== 0) {
        throw invalid("The sync update arrived out of order.");
      }
      this.incoming = {
        id,
        total,
        size,
        index: 0,
        received: 0,
        bytes: new Uint8Array(size),
      };
    }
    const incoming = this.incoming;
    if (
      id !== incoming.id ||
      total !== incoming.total ||
      size !== incoming.size ||
      index !== incoming.index
    ) {
      throw invalid("The sync update arrived out of order.");
    }
    incoming.bytes.set(payload, incoming.received);
    incoming.received += payload.byteLength;
    incoming.index += 1;
    if (incoming.index !== incoming.total) {
      return null;
    }
    this.incoming = null;
    return incoming.bytes;
  }

  clear(): void {
    this.incoming = null;
  }
}
