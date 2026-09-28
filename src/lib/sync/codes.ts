/**
 * Signaling codes: everything one device needs to reach the other, as a
 * single string that fits a QR code or a chat message.
 */
import { deflateSync, inflateSync } from "fflate";
import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from "./encoding";
import { SyncError } from "./errors";
import type { PublicKeyCoordinates } from "./identity";

export const SIGNAL_CODE_PREFIX = "leaflet1:";
export type SignalRole = "offer" | "answer";

export interface SignalPayload {
  deviceId: string;
  name: string;
  publicKey: PublicKeyCoordinates;
  role: SignalRole;
  sdp: string;
  v: 1;
}

const MAX_DECODED_BYTES = 64 * 1024;
const MAX_ENCODED_LENGTH = 96 * 1024;
const MAX_SDP_LENGTH = 60 * 1024;
const MAX_NAME_LENGTH = 120;
const MAX_ID_LENGTH = 128;
const COORDINATE = /^[A-Za-z0-9_-]{32,64}$/u;
const WHITESPACE = /\s+/gu;
/** `inflateSync` into a fixed buffer leaves the unused tail zero-filled. */
const TRAILING_NUL = /\0+$/u;

export function encodeSignalCode(payload: Omit<SignalPayload, "v">): string {
  const json = JSON.stringify({ v: 1, ...payload });
  const packed = deflateSync(utf8Encode(json), { level: 9 });
  return `${SIGNAL_CODE_PREFIX}${toBase64Url(packed)}`;
}

function invalid(): SyncError {
  return new SyncError("bad_code", "This is not a Leaflet pairing code.");
}

function readString(value: unknown, max: number, min = 1): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length >= min && trimmed.length <= max ? trimmed : null;
}

export function decodeSignalCode(
  text: string,
  expectedRole?: SignalRole
): SignalPayload {
  const compact = text.replace(WHITESPACE, "");
  if (
    compact.length > MAX_ENCODED_LENGTH ||
    !compact.startsWith(SIGNAL_CODE_PREFIX)
  ) {
    throw invalid();
  }
  const packed = fromBase64Url(compact.slice(SIGNAL_CODE_PREFIX.length));
  let bytes: Uint8Array;
  try {
    bytes = inflateSync(packed, { out: new Uint8Array(MAX_DECODED_BYTES) });
  } catch {
    throw invalid();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(bytes).replace(TRAILING_NUL, ""));
  } catch {
    throw invalid();
  }
  if (!parsed || typeof parsed !== "object") {
    throw invalid();
  }
  const record = parsed as Record<string, unknown>;
  const role = record.role;
  const deviceId = readString(record.deviceId, MAX_ID_LENGTH);
  const name = readString(record.name, MAX_NAME_LENGTH);
  const sdp = readString(record.sdp, MAX_SDP_LENGTH);
  const key = record.publicKey as Record<string, unknown> | undefined;
  if (
    record.v !== 1 ||
    (role !== "offer" && role !== "answer") ||
    !(deviceId && name && sdp) ||
    !sdp.startsWith("v=0") ||
    !key ||
    typeof key !== "object" ||
    typeof key.x !== "string" ||
    typeof key.y !== "string" ||
    !(COORDINATE.test(key.x) && COORDINATE.test(key.y))
  ) {
    throw invalid();
  }
  if (expectedRole && role !== expectedRole) {
    throw new SyncError(
      "wrong_role",
      expectedRole === "answer"
        ? "That is a pairing request, not a reply. Scan the reply code from the other device."
        : "That is a reply code. Scan the pairing request from the other device."
    );
  }
  return {
    v: 1,
    role,
    deviceId,
    name,
    sdp,
    publicKey: { x: key.x, y: key.y },
  };
}
