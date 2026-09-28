import { describe, expect, it } from "vitest";
import { Doc, encodeStateAsUpdate, encodeStateVector } from "yjs";
import {
  applyPeerUpdate,
  CHUNK_BYTES,
  encodeChunks,
  MAX_DOCUMENT_BYTES,
  MessageBudget,
  NOTES_STATE,
  normalizeReaderName,
  parsePresenceFrame,
  readAnnotations,
  UpdateAssembler,
  validateAnnotation,
  validateAuthor,
  validateLocator,
} from "./protocol";
import type { Annotation, ContentLocator } from "./types";

const chapters = new Set(["ch1", "appendix"]);
const locator: ContentLocator = {
  chapterId: "ch1",
  start: 4,
  end: 27,
  quote: " same words\n in another chapter ",
};
const idA = "3d56fb5d-01a2-4f23-8f1a-85923ec142fd";
const idB = "6f6cedca-a910-4d45-82b8-af005fe4b3e2";
const book = "a".repeat(64);

function note(id: string, chapterId = "ch1"): Annotation {
  return {
    id,
    kind: "comment",
    locator: { ...locator, chapterId },
    text: "A thought",
    createdAt: 100,
  };
}

function document(...notes: Annotation[]): Doc {
  const doc = new Doc();
  const entries = doc.getMap<Annotation>("annotations");
  for (const entry of notes) {
    entries.set(entry.id, entry);
  }
  return doc;
}

describe("reading sync trust boundaries", () => {
  it("rejects a read-only peer before decoding even malformed Yjs bytes", () => {
    const host = document(note(idA));
    const before = encodeStateAsUpdate(host);
    expect(() =>
      applyPeerUpdate(host, new Uint8Array([255, 255]), false, chapters, "peer")
    ).toThrow("Read-only");
    expect(encodeStateAsUpdate(host)).toEqual(before);
    host.destroy();
  });

  it("rejects invalid chapter data, hidden namespaces, and mismatched map keys without partial mutation", () => {
    const host = document(note(idA));
    const before = encodeStateAsUpdate(host);
    const outsiders = [
      document(note(idB, "other")),
      document(note(idB)),
      document(),
    ];
    outsiders[1].getMap("trusted-origins").set("https://example.test", true);
    outsiders[2].getMap("annotations").set(idB, note(idA));
    for (const outsider of outsiders) {
      expect(() =>
        applyPeerUpdate(
          host,
          encodeStateAsUpdate(outsider),
          true,
          chapters,
          "peer"
        )
      ).toThrow();
      expect(encodeStateAsUpdate(host)).toEqual(before);
      outsider.destroy();
    }
    host.destroy();
  });

  it("rejects an array under the annotation root and incomplete causal history", () => {
    const host = document();
    const arrayDoc = new Doc();
    arrayDoc.getArray("annotations").insert(0, ["hidden data"]);
    expect(() =>
      applyPeerUpdate(
        host,
        encodeStateAsUpdate(arrayDoc),
        true,
        chapters,
        "peer"
      )
    ).toThrow();
    const peer = document();
    const updates: Uint8Array[] = [];
    peer.on("update", (update: Uint8Array) => updates.push(update));
    peer.getMap("annotations").set(idA, note(idA));
    peer.getMap("annotations").set(idB, note(idB));
    expect(() =>
      applyPeerUpdate(host, updates[1], true, chapters, "peer")
    ).toThrow("incomplete");
    expect(readAnnotations(host, chapters)).toEqual([]);
    host.destroy();
    arrayDoc.destroy();
    peer.destroy();
  });

  it("rejects a malformed record even when Yjs conflict resolution would hide it", () => {
    const host = document(note(idA));
    const peer = document();
    peer.getMap("annotations").set(idA, note(idB));
    const before = encodeStateAsUpdate(host);
    expect(() =>
      applyPeerUpdate(host, encodeStateAsUpdate(peer), true, chapters, "peer")
    ).toThrow();
    expect(encodeStateAsUpdate(host)).toEqual(before);
    host.destroy();
    peer.destroy();
  });

  it("converges real Yjs deltas after concurrent notes, duplicate delivery, and deletion", () => {
    const left = document(note(idA));
    const right = document(note(idB, "appendix"));
    const leftUpdate = encodeStateAsUpdate(left, encodeStateVector(right));
    const rightUpdate = encodeStateAsUpdate(right, encodeStateVector(left));
    applyPeerUpdate(left, rightUpdate, true, chapters, "peer");
    applyPeerUpdate(right, leftUpdate, true, chapters, "peer");
    applyPeerUpdate(left, rightUpdate, true, chapters, "peer");
    expect(readAnnotations(left, chapters)).toEqual(
      readAnnotations(right, chapters)
    );
    right.getMap("annotations").delete(idA);
    applyPeerUpdate(
      left,
      encodeStateAsUpdate(right, encodeStateVector(left)),
      true,
      chapters,
      "peer"
    );
    expect(readAnnotations(left, chapters)).toEqual([note(idB, "appendix")]);
    left.destroy();
    right.destroy();
  });

  it("preserves exact quoted text and enforces scalar offset and bookmark invariants", () => {
    const exact = { ...locator, quote: "  天地\n👩🏽‍💻 é  " };
    expect(validateLocator(exact, chapters)).toEqual(exact);
    for (const bad of [
      { ...locator, chapterId: "other" },
      { ...locator, start: -1 },
      { ...locator, start: 1.5 },
      { ...locator, end: Number.POSITIVE_INFINITY },
      { ...locator, end: 3 },
      { ...locator, start: [4] },
      { ...locator, end: 64 * 1024 * 1024 + 1 },
      { ...locator, admin: true },
    ]) {
      expect(() => validateLocator(bad, chapters)).toThrow();
    }
    expect(() => validateLocator(Object.create(locator), chapters)).toThrow();
    expect(() =>
      validateAnnotation({ ...note(idA), kind: "bookmark", text: "" }, chapters)
    ).toThrow("bookmark");
    expect(
      validateAnnotation(
        {
          ...note(idA),
          kind: "bookmark",
          text: "",
          locator: { ...locator, start: 4, end: 4, quote: "" },
        },
        chapters
      ).locator.end
    ).toBe(4);
    expect(() =>
      validateAnnotation(
        { ...note(idA), locator: { ...locator, end: 4 } },
        chapters
      )
    ).toThrow("Select text");
  });

  it("validates optional authors and keeps author-less notes from earlier versions", () => {
    const author = { id: "reader-1", name: "Ada", color: "#C8553D" };
    const validated = validateAnnotation({ ...note(idA), author }, chapters);
    expect(validated.author).toEqual({ ...author, color: "#c8553d" });
    expect(validateAnnotation(note(idA), chapters).author).toBeUndefined();
    for (const bad of [
      { ...author, color: "red" },
      { ...author, color: "#12345" },
      { ...author, name: "" },
      { ...author, name: "x".repeat(41) },
      { ...author, id: "" },
      { ...author, id: "y".repeat(65) },
      { ...author, extra: true },
      "Ada",
    ]) {
      expect(() => validateAuthor(bad)).toThrow();
      expect(() =>
        validateAnnotation({ ...note(idA), author: bad }, chapters)
      ).toThrow();
    }
    expect(normalizeReaderName("  Ada   Lovelace  ")).toBe("Ada Lovelace");
    expect(normalizeReaderName("")).toBe("Reader");
    expect(normalizeReaderName("x".repeat(80))).toHaveLength(40);
  });

  it("parses presence frames and rejects everything else", () => {
    const hello = {
      t: "hello",
      v: 1,
      name: "Ada",
      color: "#c8553d",
      fingerprint: book,
      title: "A Book",
      readerId: "reader-1",
    };
    expect(parsePresenceFrame(hello, chapters)).toEqual({
      t: "hello",
      name: "Ada",
      color: "#c8553d",
      fingerprint: book,
      title: "A Book",
      readerId: "reader-1",
    });
    expect(parsePresenceFrame({ t: "location", locator }, chapters)).toEqual({
      t: "location",
      locator,
    });
    expect(parsePresenceFrame({ t: "bye" }, chapters)).toEqual({ t: "bye" });
    for (const bad of [
      { ...hello, v: 2 },
      { ...hello, fingerprint: "short" },
      { ...hello, title: "t".repeat(401) },
      { ...hello, extra: 1 },
      { t: "location", locator: { ...locator, chapterId: "nope" } },
      { t: "bye", now: 1 },
      { t: "shout" },
      "hello",
      null,
    ]) {
      expect(() => parsePresenceFrame(bad, chapters)).toThrow();
    }
  });

  it("bounds chunk allocation, rejects out-of-order transfers, and checks grants first", () => {
    const bytes = Uint8Array.from(
      { length: CHUNK_BYTES + 1 },
      (_, index) => index % 251
    );
    const frames = encodeChunks(bytes, 7);
    const receiver = new UpdateAssembler();
    expect(receiver.receive(frames[0], true)).toBeNull();
    expect(receiver.receive(frames[1], true)).toEqual(bytes);
    expect(() => new UpdateAssembler().receive(frames[1], true)).toThrow(
      "out of order"
    );
    expect(() =>
      new UpdateAssembler().receive(new ArrayBuffer(0), false)
    ).toThrow("Read-only");
    const excessive = frames[0].slice(0);
    new DataView(excessive).setUint32(14, MAX_DOCUMENT_BYTES + 1);
    expect(() => new UpdateAssembler().receive(excessive, true)).toThrow();
    // A state-vector frame is refused by an update assembler and vice versa.
    const vector = encodeChunks(new Uint8Array([1, 2, 3]), 8, NOTES_STATE)[0];
    expect(() => new UpdateAssembler().receive(vector, true)).toThrow();
    expect(new UpdateAssembler(NOTES_STATE).receive(vector, true)).toEqual(
      new Uint8Array([1, 2, 3])
    );
  });

  it("stops a logical message flood without credit from a backward clock", () => {
    let now = 0;
    const budget = new MessageBudget(() => now);
    for (let index = 0; index < 32; index += 1) {
      budget.consume();
    }
    expect(() => budget.consume()).toThrow("message limit");
    now = 1000;
    for (let index = 0; index < 8; index += 1) {
      budget.consume();
    }
    now = 0;
    expect(() => budget.consume()).toThrow("message limit");
  });
});
