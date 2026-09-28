/**
 * Pairing cryptography.
 *
 * Two devices each hold a long-term ECDH P-256 key pair. From their shared
 * secret and both device ids they derive:
 *
 * - an AES-GCM key that seals signaling envelopes when they travel through an
 *   untrusted relay, and
 * - an HMAC key that produces the short authentication string (SAS) users
 *   compare on both screens and the opaque relay room name.
 *
 * The SAS commits to the DTLS fingerprints of both ends of the WebRTC
 * connection, so an attacker who swapped either the signaling or the key
 * exchange produces different digits on the two screens.
 */
import {
  fromBase64Url,
  ownedBytes,
  toBase64Url,
  toHex,
  utf8Decode,
  utf8Encode,
} from "./encoding";
import { SyncError } from "./errors";
import { cleanJwk } from "./identity";

export interface SharedKeys {
  aes: CryptoKey;
  mac: CryptoKey;
}

const HKDF_INFO_AES = "leaflet-sync-v1";
const HKDF_INFO_MAC = "leaflet-sync-v1-mac";
const IV_LENGTH = 12;
const MAX_ENVELOPE_BYTES = 128 * 1024;

function subtle(): SubtleCrypto {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new SyncError(
      "crypto_unavailable",
      "This browser does not expose Web Crypto, which pairing requires."
    );
  }
  return crypto.subtle;
}

/**
 * ECDH -> HKDF-SHA256 -> { AES-GCM-256, HMAC-SHA256 }.
 * The salt is both device ids sorted and joined, so the same pair always
 * derives the same keys regardless of which side computes them.
 */
export async function deriveSharedKeys(
  myPrivateJwk: JsonWebKey,
  theirPublicJwk: JsonWebKey,
  deviceIds: [string, string]
): Promise<SharedKeys> {
  const api = subtle();
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  try {
    privateKey = await api.importKey(
      "jwk",
      cleanJwk(myPrivateJwk, true),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"]
    );
    publicKey = await api.importKey(
      "jwk",
      cleanJwk(theirPublicJwk, false),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      []
    );
  } catch {
    throw new SyncError("bad_key", "The device key could not be read.");
  }
  const secret = await api.deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey,
    256
  );
  const base = await api.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  const salt = utf8Encode([...deviceIds].sort().join("|"));
  const aes = await api.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: utf8Encode(HKDF_INFO_AES) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  const mac = await api.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: utf8Encode(HKDF_INFO_MAC) },
    base,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return { aes, mac };
}

async function hmac(keys: SharedKeys, message: string): Promise<Uint8Array> {
  const signature = await subtle().sign("HMAC", keys.mac, utf8Encode(message));
  return new Uint8Array(signature);
}

/** Six decimal digits that both devices can compute and compare. */
export async function shortAuthString(
  keys: SharedKeys,
  offerFingerprint: string,
  answerFingerprint: string
): Promise<string> {
  const digest = await hmac(keys, `${offerFingerprint}|${answerFingerprint}`);
  const view = new DataView(
    digest.buffer,
    digest.byteOffset,
    digest.byteLength
  );
  const number = view.getUint32(0, false) % 1_000_000;
  return String(number).padStart(6, "0");
}

/** Opaque relay room shared by one device pair. */
export async function roomId(keys: SharedKeys): Promise<string> {
  return toHex(await hmac(keys, "room"));
}

export async function sealEnvelope(
  keys: SharedKeys,
  plaintext: string
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = new Uint8Array(
    await subtle().encrypt(
      { name: "AES-GCM", iv },
      keys.aes,
      utf8Encode(plaintext)
    )
  );
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, iv.length);
  return toBase64Url(out);
}

export async function openEnvelope(
  keys: SharedKeys,
  sealed: string
): Promise<string> {
  if (typeof sealed !== "string" || sealed.length > MAX_ENVELOPE_BYTES * 2) {
    throw new SyncError("bad_envelope", "The relay message is malformed.");
  }
  const bytes = fromBase64Url(sealed);
  if (bytes.length <= IV_LENGTH || bytes.length > MAX_ENVELOPE_BYTES) {
    throw new SyncError("bad_envelope", "The relay message is malformed.");
  }
  try {
    const plain = await subtle().decrypt(
      { name: "AES-GCM", iv: ownedBytes(bytes.subarray(0, IV_LENGTH)) },
      keys.aes,
      ownedBytes(bytes.subarray(IV_LENGTH))
    );
    return utf8Decode(new Uint8Array(plain));
  } catch {
    throw new SyncError(
      "bad_envelope",
      "The relay message was not sealed by the paired device."
    );
  }
}
