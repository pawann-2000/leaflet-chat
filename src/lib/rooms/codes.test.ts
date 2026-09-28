import { describe, expect, it } from "vitest";
import {
  deriveRoomKeys,
  generateRoomCode,
  normalizeRoomCode,
  parseJoinUrl,
  ROOM_CODE_ALPHABET,
  roomCodeFromBytes,
  roomJoinUrl,
} from "./codes";
import { RoomError } from "./errors";

const CODE_SHAPE = /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/u;
const HEX_32 = /^[0-9a-f]{32}$/u;

describe("room codes", () => {
  it("generates twelve alphabet letters in three groups", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      const code = generateRoomCode();
      expect(code).toMatch(CODE_SHAPE);
      for (const letter of code.replaceAll("-", "")) {
        expect(ROOM_CODE_ALPHABET).toContain(letter);
      }
      seen.add(code);
    }
    expect(seen.size).toBe(50);
  });

  it.each([
    ["canonical", "ABCD-EFGH-JKMN", "ABCD-EFGH-JKMN"],
    ["lowercase, no dashes", "abcdefghjkmn", "ABCD-EFGH-JKMN"],
    ["spaces and extra dashes", " ab-cd efgh--jk mn ", "ABCD-EFGH-JKMN"],
    ["lookalikes O/I/L", "OICD-EFGH-JKML", "01CD-EFGH-JKM1"],
    ["join url", "https://leaflet.chat/join#ABCD-EFGH-JKMN", "ABCD-EFGH-JKMN"],
    [
      "join url without scheme",
      "leaflet.chat/join#abcdefghjkmn",
      "ABCD-EFGH-JKMN",
    ],
    ["path only", "/join#ABCD-EFGH-JKMN", "ABCD-EFGH-JKMN"],
    ["fragment only", "#abcd-efgh-jkmn", "ABCD-EFGH-JKMN"],
    [
      "query form",
      "https://leaflet.chat/join?code=ABCD-EFGH-JKMN",
      "ABCD-EFGH-JKMN",
    ],
  ])("normalizes %s", (_, input, expected) => {
    expect(normalizeRoomCode(input)).toBe(expected);
  });

  it.each([
    ["too short", "ABCD-EFGH"],
    ["too long", "ABCD-EFGH-JKMN-PQRS"],
    ["excluded letter U", "ABCD-EFGH-JKMU"],
    ["empty", "   "],
    ["a sentence", "join my room please"],
    ["url with another path", "https://leaflet.chat/about#ABCD-EFGH-JKMN"],
  ])("rejects %s", (_, input) => {
    expect(normalizeRoomCode(input)).toBeNull();
  });

  it("builds and parses join links without leaking the code into the path", () => {
    const url = roomJoinUrl("abcd-efgh-jkmn");
    expect(url).toBe("https://leaflet.chat/join#ABCD-EFGH-JKMN");
    expect(new URL(url).pathname).toBe("/join");
    expect(parseJoinUrl(url)).toBe("ABCD-EFGH-JKMN");
    expect(roomJoinUrl("ABCD-EFGH-JKMN", "http://localhost:1430/")).toBe(
      "http://localhost:1430/join#ABCD-EFGH-JKMN"
    );
    expect(() => roomJoinUrl("nope")).toThrowError(RoomError);
  });

  it("derives the same room id and key from equivalent spellings, and different ones otherwise", async () => {
    const a = await deriveRoomKeys("ABCD-EFGH-JKMN");
    const b = await deriveRoomKeys("abcdefghjkmn");
    const c = await deriveRoomKeys("ABCD-EFGH-JKMP");
    expect(a.roomId).toMatch(HEX_32);
    expect(a.roomId).toBe(b.roomId);
    expect(a.roomId).not.toBe(c.roomId);
    const probe = new TextEncoder().encode("hello");
    const iv = new Uint8Array(12);
    const sealedA = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, a.key, probe)
    );
    const sealedB = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, b.key, probe)
    );
    const sealedC = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, c.key, probe)
    );
    expect(sealedA).toEqual(sealedB);
    expect(sealedA).not.toEqual(sealedC);
    await expect(deriveRoomKeys("bad")).rejects.toThrowError(RoomError);
  });

  it("derives deterministic codes from key material", () => {
    const bytes = new Uint8Array(20).map((_, index) => index * 7);
    expect(roomCodeFromBytes(bytes)).toBe(roomCodeFromBytes(bytes));
    expect(roomCodeFromBytes(bytes)).toMatch(CODE_SHAPE);
    expect(() => roomCodeFromBytes(new Uint8Array(3))).toThrowError(RoomError);
  });
});
