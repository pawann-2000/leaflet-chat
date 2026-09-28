import { describe, expect, it } from "vitest";
import { SyncError } from "./errors";
import {
  CHUNK_SIZE,
  encodeMessage,
  frameChunk,
  parseChunk,
  parseMessage,
} from "./messages";

const ID = "c".repeat(64);
const CHUNK_COUNT = /chunkCount/u;

describe("chunk framing", () => {
  it("round-trips a sequence number and payload", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const { seq, data: out } = parseChunk(frameChunk(7, data));
    expect(seq).toBe(7);
    expect([...out]).toEqual([1, 2, 3, 4, 5]);
  });

  it("rejects oversized and truncated frames", () => {
    expect(() => frameChunk(0, new Uint8Array(CHUNK_SIZE + 1))).toThrowError(
      SyncError
    );
    expect(() => parseChunk(new ArrayBuffer(2))).toThrowError(SyncError);
  });
});

describe("parseMessage", () => {
  it("accepts a well-formed hello and rejects a bad one", () => {
    const hello = encodeMessage({
      t: "hello",
      deviceId: "a",
      name: "A",
      sas: "123456",
    });
    expect(parseMessage(hello)).toEqual({
      t: "hello",
      deviceId: "a",
      name: "A",
      sas: "123456",
    });
    expect(() =>
      parseMessage(
        JSON.stringify({ t: "hello", deviceId: "a", name: "A", sas: "1" })
      )
    ).toThrowError(SyncError);
  });

  it("rejects unknown types, invalid JSON and inconsistent book headers", () => {
    expect(() => parseMessage("{")).toThrowError(SyncError);
    expect(() => parseMessage(JSON.stringify({ t: "nope" }))).toThrowError(
      SyncError
    );
    expect(() =>
      parseMessage(JSON.stringify({ t: "want-book", id: "short" }))
    ).toThrowError(SyncError);
    const record = {
      addedAt: 1,
      authors: [],
      chapterCount: 1,
      coverPath: null,
      deletedAt: null,
      fileName: "b.epub",
      id: ID,
      language: null,
      lastOpenedAt: 1,
      pageDirection: "default",
      size: 100,
      title: "B",
      updatedAt: 1,
    };
    expect(() =>
      parseMessage(
        JSON.stringify({
          t: "book-begin",
          id: ID,
          fileName: "b.epub",
          size: 100,
          chunkCount: 5,
          record,
        })
      )
    ).toThrowError(CHUNK_COUNT);
    expect(
      parseMessage(
        JSON.stringify({
          t: "book-begin",
          id: ID,
          fileName: "b.epub",
          size: 100,
          chunkCount: 1,
          record,
        })
      ).t
    ).toBe("book-begin");
  });

  it("only accepts normalized http(s) origins in trusted records", () => {
    const good = {
      t: "trusted",
      items: [
        {
          origin: "https://example.com",
          trustedAt: 1,
          updatedAt: 1,
          deletedAt: null,
        },
      ],
    };
    expect(parseMessage(JSON.stringify(good)).t).toBe("trusted");
    for (const origin of [
      "https://example.com/path",
      "javascript:alert(1)",
      "example.com",
    ]) {
      expect(() =>
        parseMessage(
          JSON.stringify({
            t: "trusted",
            items: [{ origin, trustedAt: 1, updatedAt: 1, deletedAt: null }],
          })
        )
      ).toThrowError(SyncError);
    }
  });
});
