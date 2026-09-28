import { describe, expect, it } from "vitest";
import {
  decodeSignalCode,
  encodeSignalCode,
  SIGNAL_CODE_PREFIX,
} from "./codes";
import { SyncError } from "./errors";

const SDP = [
  "v=0",
  "o=- 1 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=fingerprint:sha-256 AA:BB:CC:DD",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
].join("\r\n");
const KEY = { x: "f".repeat(43), y: "g".repeat(43) };
const BASE64_ONLY_CHARS = /[+/=]/u;
const PAIRING_CODE_MESSAGE = /pairing code/u;

function payload(role: "offer" | "answer" = "offer") {
  return {
    role,
    deviceId: "device-a",
    name: "Chrome on Android",
    publicKey: KEY,
    sdp: SDP,
  };
}

describe("signal codes", () => {
  it("round-trips a payload", () => {
    const code = encodeSignalCode(payload());
    expect(code.startsWith(SIGNAL_CODE_PREFIX)).toBe(true);
    expect(code).not.toMatch(BASE64_ONLY_CHARS);
    expect(decodeSignalCode(code)).toEqual({ v: 1, ...payload() });
  });

  it("ignores whitespace and line breaks from messengers", () => {
    const code = encodeSignalCode(payload("answer"));
    const wrapped = code.replace(/(.{40})/gu, "$1\n ");
    expect(decodeSignalCode(wrapped, "answer").role).toBe("answer");
  });

  it("rejects the wrong role with a distinct code", () => {
    const code = encodeSignalCode(payload("offer"));
    expect(() => decodeSignalCode(code, "answer")).toThrowError(SyncError);
    try {
      decodeSignalCode(code, "answer");
    } catch (error) {
      expect((error as SyncError).code).toBe("wrong_role");
    }
  });

  it.each([
    ["random text", "hello there"],
    ["wrong prefix", `leaflet2:${encodeSignalCode(payload()).slice(9)}`],
    ["not deflate", `${SIGNAL_CODE_PREFIX}AAAA`],
    ["bad base64", `${SIGNAL_CODE_PREFIX}!!!`],
  ])("rejects %s", (_, text) => {
    expect(() => decodeSignalCode(text)).toThrowError(SyncError);
  });

  it("rejects payloads that fail the schema", () => {
    const bad = encodeSignalCode({ ...payload(), sdp: "not an sdp" });
    expect(() => decodeSignalCode(bad)).toThrowError(PAIRING_CODE_MESSAGE);
    const badKey = encodeSignalCode({
      ...payload(),
      publicKey: { x: "short", y: KEY.y },
    });
    expect(() => decodeSignalCode(badKey)).toThrowError(SyncError);
  });
});
