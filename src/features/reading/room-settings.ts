/**
 * Per-browser preferences for reading rooms. Kept in a dependency-free module
 * so the library screen can read them without loading the room stack.
 */
export const DEFAULT_RELAY_URL = "wss://rooms.leaflet.chat";

const NAME_KEY = "leaflet.reader-name";
const RELAY_KEY = "leaflet.relay-url";

function readSetting(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeSetting(key: string, value: string): void {
  try {
    if (value) {
      localStorage.setItem(key, value);
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    // Private mode: the value simply lives for this session.
  }
}

export function storedReaderName(): string {
  return readSetting(NAME_KEY, "");
}

export function saveReaderName(name: string): void {
  writeSetting(NAME_KEY, name.trim());
}

export function storedRelayUrl(): string {
  return readSetting(RELAY_KEY, DEFAULT_RELAY_URL);
}

/** Saves a custom relay; the default is stored as "no override". */
export function saveRelayUrl(url: string): void {
  const trimmed = url.trim();
  writeSetting(RELAY_KEY, trimmed === DEFAULT_RELAY_URL ? "" : trimmed);
}
