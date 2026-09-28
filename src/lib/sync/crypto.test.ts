import { describe, expect, it } from "vitest";
import {
  deriveSharedKeys,
  openEnvelope,
  roomId,
  sealEnvelope,
  shortAuthString,
} from "./crypto";
import { SyncError } from "./errors";
import { cleanJwk } from "./identity";

const SIX_DIGITS = /^\d{6}$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;

async function keyPair() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  return {
    privateKey: cleanJwk(
      await crypto.subtle.exportKey("jwk", pair.privateKey),
      true
    ),
    publicKey: cleanJwk(
      await crypto.subtle.exportKey("jwk", pair.publicKey),
      false
    ),
  };
}

describe("pairing crypto", () => {
  it("derives identical keys and SAS on both devices", async () => {
    const a = await keyPair();
    const b = await keyPair();
    const keysA = await deriveSharedKeys(a.privateKey, b.publicKey, ["a", "b"]);
    const keysB = await deriveSharedKeys(b.privateKey, a.publicKey, ["b", "a"]);
    const sasA = await shortAuthString(keysA, "sha-256 AA", "sha-256 BB");
    const sasB = await shortAuthString(keysB, "sha-256 AA", "sha-256 BB");
    expect(sasA).toBe(sasB);
    expect(sasA).toMatch(SIX_DIGITS);
    expect(await roomId(keysA)).toBe(await roomId(keysB));
    expect(await roomId(keysA)).toMatch(HEX_64);
  });

  it("changes the SAS when a fingerprint changes", async () => {
    const a = await keyPair();
    const b = await keyPair();
    const keys = await deriveSharedKeys(a.privateKey, b.publicKey, ["a", "b"]);
    expect(await shortAuthString(keys, "sha-256 AA", "sha-256 BB")).not.toBe(
      await shortAuthString(keys, "sha-256 AA", "sha-256 BC")
    );
  });

  it("seals envelopes only the pair can open and detects tampering", async () => {
    const a = await keyPair();
    const b = await keyPair();
    const c = await keyPair();
    const keysA = await deriveSharedKeys(a.privateKey, b.publicKey, ["a", "b"]);
    const keysB = await deriveSharedKeys(b.privateKey, a.publicKey, ["a", "b"]);
    const keysC = await deriveSharedKeys(c.privateKey, a.publicKey, ["a", "c"]);
    const sealed = await sealEnvelope(keysA, "offer:v=0");
    expect(await openEnvelope(keysB, sealed)).toBe("offer:v=0");
    await expect(openEnvelope(keysC, sealed)).rejects.toThrowError(SyncError);
    const flipped = `${sealed.slice(0, -2)}${sealed.at(-2) === "A" ? "B" : "A"}${sealed.at(-1)}`;
    await expect(openEnvelope(keysB, flipped)).rejects.toThrowError(SyncError);
    await expect(openEnvelope(keysB, "")).rejects.toThrowError(SyncError);
  });
});
