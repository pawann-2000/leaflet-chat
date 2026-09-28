/**
 * Who this browser is inside a reading room: a stable random reader id, a
 * display name, and a colour picked from a paper-friendly palette.
 */
import { normalizeReaderName } from "./protocol";

export const READER_ID_KEY = "leaflet.reader-id";
export const READER_NAME_KEY = "leaflet.reader-name";

/** Eight ink colours that read well on cream and on dark paper. */
export const READER_COLORS: readonly string[] = [
  "#c8553d", // coral
  "#b8860b", // gold
  "#4f8a5b", // leaf
  "#4a7bb7", // ink blue
  "#8e5ea6", // plum
  "#b4685a", // clay
  "#2f8f8c", // teal
  "#a8536b", // rose
];

let memoryReaderId: string | null = null;
let memoryReaderName: string | null = null;

function readLocal(key: string): string | null {
  try {
    return typeof localStorage === "undefined"
      ? null
      : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, value);
    }
  } catch {
    // Private mode: the value lives in memory for this page.
  }
}

/** The per-browser author id; minted on first use and kept in localStorage. */
export function localReaderId(): string {
  const stored = readLocal(READER_ID_KEY);
  if (stored) {
    return stored;
  }
  if (!memoryReaderId) {
    memoryReaderId = crypto.randomUUID();
    writeLocal(READER_ID_KEY, memoryReaderId);
  }
  return memoryReaderId;
}

export function storedReaderName(): string | null {
  const stored = readLocal(READER_NAME_KEY);
  return stored ? normalizeReaderName(stored) : memoryReaderName;
}

export function rememberReaderName(name: string): string {
  const normalized = normalizeReaderName(name);
  memoryReaderName = normalized;
  writeLocal(READER_NAME_KEY, normalized);
  return normalized;
}

/** Deterministic palette pick: the same reader is the same colour everywhere. */
export function colorForReader(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) % 0x7f_ff_ff_ff;
  }
  return READER_COLORS[hash % READER_COLORS.length];
}
