/**
 * Room codes: twelve Crockford base32 characters (60 bits of entropy) shown
 * as `ABCD-EFGH-JKLM`. The code is the only secret: the relay learns just a
 * hash of it (the room id) and every payload is sealed with a key derived
 * from it, so a relay operator can route messages but never read them.
 */
import { RoomError } from "./errors";

/** Crockford base32: no I, L, O or U, so codes survive being read aloud. */
export const ROOM_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ROOM_CODE_LENGTH = 12;
export const DEFAULT_JOIN_ORIGIN = "https://leaflet.chat";

const ROOM_ID_PREFIX = "leaflet-room-v1:";
const HKDF_SALT = "leaflet-room-v1";
const HKDF_INFO = "envelope";
const ROOM_ID_BYTES = 16;
const GROUP = 4;
const NOT_CODE_CHARS = /[^0-9A-Z]/gu;
const LOOKALIKES: Record<string, string> = { O: "0", I: "1", L: "1" };
const LOOKALIKE = /[OIL]/gu;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//iu;
const TRAILING_SLASHES = /\/+$/u;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const encoder = new TextEncoder();

function randomBytes(length: number): Uint8Array {
  if (typeof crypto === "undefined" || !crypto.getRandomValues) {
    throw new RoomError(
      "unsupported",
      "This browser cannot generate a secure room code."
    );
  }
  return crypto.getRandomValues(new Uint8Array(length));
}

/** `ABCDEFGHJKLM` -> `ABCD-EFGH-JKLM`. Input must already be canonical letters. */
function group(letters: string): string {
  const parts: string[] = [];
  for (let index = 0; index < letters.length; index += GROUP) {
    parts.push(letters.slice(index, index + GROUP));
  }
  return parts.join("-");
}

/** A fresh code with 60 bits of entropy (each letter is 5 uniform bits). */
export function generateRoomCode(): string {
  const bytes = randomBytes(ROOM_CODE_LENGTH);
  let letters = "";
  for (const byte of bytes) {
    // 256 is a multiple of 32, so the low five bits are uniform.
    // biome-ignore lint/suspicious/noBitwiseOperators: masking five bits of a byte
    letters += ROOM_CODE_ALPHABET[byte & 31];
  }
  return group(letters);
}

/**
 * Canonical `XXXX-XXXX-XXXX` for anything a person might paste: lowercase,
 * missing or extra dashes and spaces, the letters O/I/L typed for 0/1, a
 * join URL, or a bare `#code` fragment. `null` when it cannot be a code.
 */
export function normalizeRoomCode(input: string): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 2048) {
    return null;
  }
  const fromUrl = parseJoinUrl(trimmed);
  const raw = fromUrl ?? trimmed;
  const letters = raw
    .toUpperCase()
    .replace(LOOKALIKE, (letter) => LOOKALIKES[letter] ?? letter)
    .replace(NOT_CODE_CHARS, "");
  if (letters.length !== ROOM_CODE_LENGTH) {
    return null;
  }
  for (const letter of letters) {
    if (!ROOM_CODE_ALPHABET.includes(letter)) {
      return null;
    }
  }
  return group(letters);
}

function requireCode(code: string): string {
  const normalized = normalizeRoomCode(code);
  if (!normalized) {
    throw new RoomError("bad_code", "That is not a Leaflet room code.");
  }
  return normalized;
}

/** `https://leaflet.chat/join#ABCD-EFGH-JKLM`; the code never leaves the fragment. */
export function roomJoinUrl(
  code: string,
  origin: string = DEFAULT_JOIN_ORIGIN
): string {
  const base = origin.replace(TRAILING_SLASHES, "");
  return `${base}/join#${requireCode(code)}`;
}

/**
 * The origin to put in join links: this site when it is a real web origin,
 * leaflet.chat when running from localhost or inside the desktop shell.
 */
export function defaultJoinOrigin(): string {
  if (typeof location === "undefined") {
    return DEFAULT_JOIN_ORIGIN;
  }
  const { protocol, hostname, origin } = location;
  if (
    (protocol === "https:" || protocol === "http:") &&
    !LOCAL_HOSTS.has(hostname) &&
    !hostname.endsWith(".localhost")
  ) {
    return origin;
  }
  return DEFAULT_JOIN_ORIGIN;
}

/**
 * The code carried by a join link (`https://leaflet.chat/join#CODE`,
 * `leaflet.chat/join#CODE`, `/join#CODE` or just `#CODE`), else `null`.
 * Returns the raw fragment; callers normalize it.
 */
export function parseJoinUrl(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("#")) {
    return trimmed.slice(1) || null;
  }
  const looksLikeUrl =
    HAS_SCHEME.test(trimmed) ||
    trimmed.startsWith("/join") ||
    trimmed.includes("/join#") ||
    trimmed.includes("/join?");
  if (!looksLikeUrl) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(
      HAS_SCHEME.test(trimmed) || trimmed.startsWith("/")
        ? trimmed
        : `https://${trimmed}`,
      DEFAULT_JOIN_ORIGIN
    );
  } catch {
    return null;
  }
  if (!url.pathname.replace(TRAILING_SLASHES, "").endsWith("/join")) {
    return null;
  }
  if (url.hash.length > 1) {
    return decodeURIComponent(url.hash.slice(1));
  }
  const query = url.searchParams.get("code");
  return query ? query : null;
}

export interface RoomKeys {
  /** AES-GCM-256 key sealing every payload in the room. */
  key: CryptoKey;
  /** 32 lowercase hex characters: the only thing the relay learns about the code. */
  roomId: string;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function subtle(): SubtleCrypto {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new RoomError(
      "crypto",
      "This browser does not expose Web Crypto, which rooms require."
    );
  }
  return crypto.subtle;
}

/**
 * roomId = SHA-256("leaflet-room-v1:" + code)[0..16] as hex,
 * key    = HKDF-SHA256(ikm = code, salt = "leaflet-room-v1", info = "envelope").
 */
export async function deriveRoomKeys(code: string): Promise<RoomKeys> {
  const canonical = requireCode(code);
  const api = subtle();
  const digest = new Uint8Array(
    await api.digest("SHA-256", encoder.encode(ROOM_ID_PREFIX + canonical))
  );
  const base = await api.importKey(
    "raw",
    encoder.encode(canonical),
    "HKDF",
    false,
    ["deriveKey"]
  );
  const key = await api.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(HKDF_SALT),
      info: encoder.encode(HKDF_INFO),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  return { roomId: toHex(digest.subarray(0, ROOM_ID_BYTES)), key };
}

/** Deterministic code from secret bytes; used when two paired devices meet without typing anything. */
export function roomCodeFromBytes(bytes: Uint8Array): string {
  if (bytes.length < ROOM_CODE_LENGTH) {
    throw new RoomError("bad_code", "Not enough key material for a room code.");
  }
  let letters = "";
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    // biome-ignore lint/suspicious/noBitwiseOperators: masking five bits of a byte
    letters += ROOM_CODE_ALPHABET[bytes[index] & 31];
  }
  return group(letters);
}
