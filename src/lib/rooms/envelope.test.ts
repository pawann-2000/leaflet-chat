import { describe, expect, it } from "vitest";
import { deriveRoomKeys } from "./codes";
import {
  decodeJson,
  decodePayload,
  decodePlaintext,
  encodePayload,
  encodePlaintext,
  envelopeAad,
  open,
  SequenceCounter,
  SequenceTracker,
  seal,
} from "./envelope";
import { RoomError } from "./errors";

const STANDARD_BASE64_CHARS = /[+/=]/u;

describe("envelopes", () => {
  it("seals and opens under the same AAD, and rejects a changed AAD or tampering", async () => {
    const { key, roomId } = await deriveRoomKeys("ABCD-EFGH-JKMN");
    const aad = envelopeAad(roomId, "m1", "notes", 7);
    const plaintext = encodePlaintext({ hello: "world" });
    const sealed = await seal(key, plaintext, aad);
    const opened = await open(key, sealed, aad);
    expect(opened).toEqual(plaintext);
    const decoded = decodePlaintext(opened);
    expect(decoded.kind).toBe("json");
    expect(decodeJson(decoded.data)).toEqual({ hello: "world" });

    await expect(
      open(key, sealed, envelopeAad(roomId, "m2", "notes", 7))
    ).rejects.toThrowError(RoomError);
    await expect(
      open(key, sealed, envelopeAad(roomId, "m1", "notes", 8))
    ).rejects.toThrowError(RoomError);
    const tampered = sealed.slice();
    const lastIndex = tampered.length - 1;
    tampered[lastIndex] = (tampered[lastIndex] + 1) % 256;
    await expect(open(key, tampered, aad)).rejects.toThrowError(RoomError);
    const other = await deriveRoomKeys("ABCD-EFGH-JKMP");
    await expect(open(other.key, sealed, aad)).rejects.toThrowError(RoomError);
  });

  it("round-trips payload framing with the sequence number in the clear", async () => {
    const { key, roomId } = await deriveRoomKeys("ABCD-EFGH-JKMN");
    const bytes = new Uint8Array([1, 2, 3, 250]);
    const sealed = await seal(
      key,
      encodePlaintext(bytes),
      envelopeAad(roomId, "m1", "bulk", 123_456)
    );
    const payload = encodePayload(123_456, sealed);
    expect(payload).not.toMatch(STANDARD_BASE64_CHARS);
    const decoded = decodePayload(payload);
    expect(decoded.seq).toBe(123_456);
    const plain = decodePlaintext(
      await open(
        key,
        decoded.envelope,
        envelopeAad(roomId, "m1", "bulk", 123_456)
      )
    );
    expect(plain.kind).toBe("bytes");
    expect(plain.data).toEqual(bytes);
    expect(() => decodePayload("AAAA")).toThrowError(RoomError);
  });

  it("rejects replays and out-of-order frames per sender", () => {
    const tracker = new SequenceTracker();
    expect(tracker.accept("a", 10)).toBe(true);
    expect(tracker.accept("a", 10)).toBe(false);
    expect(tracker.accept("a", 9)).toBe(false);
    expect(tracker.accept("a", 11)).toBe(true);
    expect(tracker.accept("b", 3)).toBe(true);
    expect(tracker.accept("a", -1)).toBe(false);
    expect(tracker.accept("a", 1.5)).toBe(false);
    tracker.forget("a");
    expect(tracker.accept("a", 1)).toBe(true);
  });

  it("issues strictly increasing sequence numbers from a random start", () => {
    const counter = new SequenceCounter();
    const first = counter.take();
    expect(counter.take()).toBe(first + 1);
    const wrapping = new SequenceCounter(0xff_ff_ff_ff);
    expect(wrapping.take()).toBe(0xff_ff_ff_ff);
    expect(wrapping.take()).toBe(0);
  });
});
