/**
 * End-to-end sealing of room payloads.
 *
 * payload = base64url( seq(4, big-endian) ‖ nonce(12) ‖ AES-GCM ciphertext )
 * AAD     = `${roomId}|${from}|${channel}|${seq}`
 *
 * The relay assigns `from`, so a relay that re-attributed a message would
 * break the tag; the sequence number is bound the same way and receivers
 * insist it strictly increases per sender, which rejects replays.
 *
 * Plaintext carries a one-byte kind prefix: 0 = JSON (UTF-8), 1 = raw bytes.
 */
import { RoomError } from "./errors";

export const KIND_JSON = 0;
export const KIND_BYTES = 1;
export const NONCE_BYTES = 12;
export const SEQ_BYTES = 4;
/** Ciphertext = plaintext + 16-byte tag. */
export const TAG_BYTES = 16;
const MAX_SEQ = 0xff_ff_ff_ff;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const PLUS = /\+/gu;
const SLASH = /\//gu;
const PADDING = /=+$/u;
const DASH = /-/gu;
const UNDERSCORE = /_/gu;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x80_00;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary)
    .replace(PLUS, "-")
    .replace(SLASH, "_")
    .replace(PADDING, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const normalized = text.replace(DASH, "+").replace(UNDERSCORE, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new RoomError("bad_code", "The payload is not valid base64url.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
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

/** Copy into a fresh, non-shared ArrayBuffer so Web Crypto accepts it. */
function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

export function envelopeAad(
  roomId: string,
  from: string,
  channel: string,
  seq: number
): string {
  return `${roomId}|${from}|${channel}|${seq}`;
}

/** nonce ‖ ciphertext for one plaintext under `aad`. */
export async function seal(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad: string
): Promise<Uint8Array<ArrayBuffer>> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = new Uint8Array(
    await subtle().encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(aad) },
      key,
      owned(plaintext)
    )
  );
  const out = new Uint8Array(NONCE_BYTES + ciphertext.length);
  out.set(nonce, 0);
  out.set(ciphertext, NONCE_BYTES);
  return out;
}

/** Inverse of `seal`; throws `RoomError("forbidden")` when the tag or AAD fails. */
export async function open(
  key: CryptoKey,
  envelope: Uint8Array,
  aad: string
): Promise<Uint8Array<ArrayBuffer>> {
  if (envelope.length < NONCE_BYTES + TAG_BYTES) {
    throw new RoomError("forbidden", "The room message is malformed.");
  }
  try {
    const plain = await subtle().decrypt(
      {
        name: "AES-GCM",
        iv: owned(envelope.subarray(0, NONCE_BYTES)),
        additionalData: encoder.encode(aad),
      },
      key,
      owned(envelope.subarray(NONCE_BYTES))
    );
    return new Uint8Array(plain);
  } catch {
    throw new RoomError(
      "forbidden",
      "The room message was not sealed with this room's code."
    );
  }
}

/** JSON or bytes -> kind-prefixed plaintext. */
export function encodePlaintext(data: Uint8Array | object): Uint8Array {
  const body =
    data instanceof Uint8Array ? data : encoder.encode(JSON.stringify(data));
  const out = new Uint8Array(1 + body.length);
  out[0] = data instanceof Uint8Array ? KIND_BYTES : KIND_JSON;
  out.set(body, 1);
  return out;
}

export interface DecodedPlaintext {
  data: Uint8Array;
  kind: "bytes" | "json";
}

export function decodePlaintext(plaintext: Uint8Array): DecodedPlaintext {
  if (!plaintext.length) {
    throw new RoomError("forbidden", "The room message is empty.");
  }
  const kind = plaintext[0];
  if (kind !== KIND_JSON && kind !== KIND_BYTES) {
    throw new RoomError("forbidden", "The room message has an unknown kind.");
  }
  return {
    kind: kind === KIND_JSON ? "json" : "bytes",
    data: plaintext.subarray(1),
  };
}

/** Parse the JSON body of a `kind: "json"` message; throws on invalid UTF-8/JSON. */
export function decodeJson(data: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(data));
  } catch {
    throw new RoomError("forbidden", "The room message is not valid JSON.");
  }
}

/** seq ‖ nonce ‖ ciphertext -> base64url payload. */
export function encodePayload(seq: number, sealed: Uint8Array): string {
  const out = new Uint8Array(SEQ_BYTES + sealed.length);
  new DataView(out.buffer).setUint32(0, seq, false);
  out.set(sealed, SEQ_BYTES);
  return toBase64Url(out);
}

export interface DecodedPayload {
  envelope: Uint8Array;
  seq: number;
}

export function decodePayload(payload: string): DecodedPayload {
  const bytes = fromBase64Url(payload);
  if (bytes.length < SEQ_BYTES + NONCE_BYTES + TAG_BYTES) {
    throw new RoomError("forbidden", "The room message is malformed.");
  }
  const seq = new DataView(bytes.buffer).getUint32(0, false);
  return { seq, envelope: bytes.subarray(SEQ_BYTES) };
}

/** Per-sender monotonic counter; strictly increasing or the frame is a replay. */
export class SequenceTracker {
  private readonly last = new Map<string, number>();

  /** True when `seq` is newer than everything seen from `sender`. */
  accept(sender: string, seq: number): boolean {
    if (!Number.isInteger(seq) || seq < 0 || seq > MAX_SEQ) {
      return false;
    }
    const previous = this.last.get(sender);
    if (previous !== undefined && seq <= previous) {
      return false;
    }
    this.last.set(sender, seq);
    return true;
  }

  forget(sender: string): void {
    this.last.delete(sender);
  }

  clear(): void {
    this.last.clear();
  }
}

/** A sender's own counter: starts at a random offset so replays across sessions cannot line up. */
export class SequenceCounter {
  private next: number;

  constructor(start?: number) {
    if (start === undefined) {
      const seed = crypto.getRandomValues(new Uint32Array(1))[0];
      // Leave room for 2^31 messages before wrapping.
      this.next = seed % 0x80_00_00_00;
    } else {
      this.next = start;
    }
  }

  take(): number {
    const value = this.next;
    this.next = value >= MAX_SEQ ? 0 : value + 1;
    return value;
  }
}
