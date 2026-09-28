import type { DeviceIdentity, LeafletStore } from "@/lib/db/types";
import { SyncError } from "./errors";

/** Public coordinates of a P-256 key as carried inside pairing codes. */
export interface PublicKeyCoordinates {
  x: string;
  y: string;
}

const MAX_NAME_LENGTH = 60;
const WHITESPACE = /\s+/gu;
const NOT_A_BRAND = /not.?a.?brand|chromium/iu;
const MICROSOFT_PREFIX = /^Microsoft /u;
const GOOGLE_PREFIX = /^Google /u;

/** Order matters: later entries also match the earlier browsers' agents. */
const BROWSERS: [RegExp, string][] = [
  [/Edg\//u, "Edge"],
  [/OPR\//u, "Opera"],
  [/SamsungBrowser/u, "Samsung Internet"],
  [/Firefox|FxiOS/u, "Firefox"],
  [/CriOS|Chrome/u, "Chrome"],
  [/Safari/u, "Safari"],
];

const PLATFORMS: [RegExp, string, string | null][] = [
  [/iPhone/u, "iPhone", null],
  [/iPad/u, "iPad", null],
  [/Android/u, "Android", "Android"],
  [/Windows/u, "Windows", "Windows"],
  [/Mac OS X|Macintosh/u, "Mac", "macOS"],
  [/CrOS/u, "ChromeOS", "Chrome OS"],
  [/Linux/u, "Linux", "Linux"],
];

interface NavigatorWithUaData extends Navigator {
  userAgentData?: { platform?: string; brands?: { brand: string }[] };
}

function browserName(agent: string, brands: string[]): string {
  const brand = brands.find((value) => !NOT_A_BRAND.test(value));
  if (brand) {
    return brand.replace(MICROSOFT_PREFIX, "").replace(GOOGLE_PREFIX, "");
  }
  return BROWSERS.find(([pattern]) => pattern.test(agent))?.[1] ?? "Browser";
}

function platformName(agent: string, platform: string | undefined): string {
  const match = PLATFORMS.find(
    ([pattern, , hint]) =>
      pattern.test(agent) || (hint !== null && hint === platform)
  );
  return match?.[1] ?? "device";
}

/** "Chrome on Android", "Safari on iPhone", … from what the browser reveals. */
export function guessDeviceName(nav?: Navigator): string {
  const source =
    nav ?? (typeof navigator === "undefined" ? undefined : navigator);
  if (!source) {
    return "This device";
  }
  const agent = source.userAgent ?? "";
  const data = (source as NavigatorWithUaData).userAgentData;
  const brands = data?.brands?.map((entry) => entry.brand) ?? [];
  return `${browserName(agent, brands)} on ${platformName(agent, data?.platform)}`;
}

export function normalizeDeviceName(name: string): string {
  const trimmed = name
    .replace(WHITESPACE, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return trimmed || "This device";
}

function isJwk(value: unknown): value is JsonWebKey {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.kty === "EC" &&
    record.crv === "P-256" &&
    typeof record.x === "string" &&
    typeof record.y === "string"
  );
}

function isIdentity(value: unknown): value is DeviceIdentity {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.deviceId === "string" &&
    typeof record.name === "string" &&
    isJwk(record.privateKey) &&
    typeof (record.privateKey as JsonWebKey).d === "string" &&
    isJwk(record.publicKey)
  );
}

/** Keep only the fields Web Crypto needs so `key_ops` never conflicts on import. */
export function cleanJwk(jwk: JsonWebKey, includePrivate: boolean): JsonWebKey {
  const clean: JsonWebKey = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
  if (includePrivate && jwk.d) {
    clean.d = jwk.d;
  }
  return clean;
}

/** Loads this device's identity, minting a new one on first use. */
export async function ensureDeviceIdentity(
  store: LeafletStore
): Promise<DeviceIdentity> {
  const existing = await store.getSetting("device");
  if (isIdentity(existing)) {
    return existing;
  }
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new SyncError(
      "crypto_unavailable",
      "This browser does not expose Web Crypto, which pairing requires."
    );
  }
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const identity: DeviceIdentity = {
    deviceId: crypto.randomUUID(),
    name: guessDeviceName(),
    privateKey: cleanJwk(privateKey, true),
    publicKey: cleanJwk(publicKey, false),
  };
  await store.putSetting("device", identity);
  return identity;
}

export function publicKeyCoordinates(jwk: JsonWebKey): PublicKeyCoordinates {
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new SyncError("bad_key", "The device key is incomplete.");
  }
  return { x: jwk.x, y: jwk.y };
}

export function publicKeyFromCoordinates(
  coordinates: PublicKeyCoordinates
): JsonWebKey {
  return { kty: "EC", crv: "P-256", x: coordinates.x, y: coordinates.y };
}
