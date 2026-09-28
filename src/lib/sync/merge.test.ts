import { describe, expect, it } from "vitest";
import type {
  BookRecord,
  ProgressRecord,
  TrustedOriginRecord,
} from "@/lib/db/types";
import { buildManifest, mergeBookRecord, planSync } from "./merge";

const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);

function book(
  id: string,
  updatedAt: number,
  deletedAt: number | null = null
): BookRecord {
  return {
    addedAt: 1,
    authors: [],
    chapterCount: 1,
    coverPath: null,
    deletedAt,
    fileName: "book.epub",
    id,
    language: null,
    lastOpenedAt: updatedAt,
    pageDirection: "default",
    size: 10,
    title: "Book",
    updatedAt,
  };
}

function progress(bookId: string, updatedAt: number): ProgressRecord {
  return { bookId, chapterIndex: 1, progress: 0.5, updatedAt };
}

function trusted(
  origin: string,
  updatedAt: number,
  deletedAt: number | null = null
): TrustedOriginRecord {
  return { origin, trustedAt: 1, updatedAt, deletedAt };
}

describe("planSync", () => {
  it("sends newer local progress and keeps older", () => {
    const local = {
      books: [],
      progress: [progress(ID_A, 20), progress(ID_B, 5)],
      trusted: [],
    };
    const peer = buildManifest({
      books: [],
      progress: [progress(ID_A, 10), progress(ID_B, 9)],
      trusted: [],
    });
    const plan = planSync(local, peer);
    expect(plan.sendProgress.map((item) => item.bookId)).toEqual([ID_A]);
  });

  it("does nothing on equal timestamps", () => {
    const local = {
      books: [book(ID_A, 10)],
      progress: [progress(ID_A, 10)],
      trusted: [trusted("https://a.test", 10)],
    };
    const plan = planSync(local, buildManifest(local));
    expect(plan).toEqual({
      deleteBooks: [],
      sendBookRecords: [],
      sendProgress: [],
      sendTrusted: [],
      wantBooks: [],
    });
  });

  it("requests books the peer has and we lack, or that we deleted before the peer re-added", () => {
    const local = { books: [book(ID_B, 5, 5)], progress: [], trusted: [] };
    const peer = buildManifest({
      books: [book(ID_A, 3), book(ID_B, 9)],
      progress: [],
      trusted: [],
    });
    expect(planSync(local, peer).wantBooks).toEqual([ID_A, ID_B]);
  });

  it("keeps our newer deletion instead of re-requesting", () => {
    const local = { books: [book(ID_B, 9, 9)], progress: [], trusted: [] };
    const peer = buildManifest({
      books: [book(ID_B, 5)],
      progress: [],
      trusted: [],
    });
    expect(planSync(local, peer).wantBooks).toEqual([]);
  });

  it("deletes locally when the peer's tombstone is newer, not when older", () => {
    const local = {
      books: [book(ID_A, 5), book(ID_B, 9)],
      progress: [],
      trusted: [],
    };
    const peer = buildManifest({
      books: [book(ID_A, 7, 7), book(ID_B, 3, 3)],
      progress: [],
      trusted: [],
    });
    expect(planSync(local, peer).deleteBooks).toEqual([
      { id: ID_A, deletedAt: 7 },
    ]);
  });

  it("sends newer live metadata for books both hold", () => {
    const local = {
      books: [book(ID_A, 9), book(ID_B, 2)],
      progress: [],
      trusted: [],
    };
    const peer = buildManifest({
      books: [book(ID_A, 4), book(ID_B, 6)],
      progress: [],
      trusted: [],
    });
    expect(
      planSync(local, peer).sendBookRecords.map((item) => item.id)
    ).toEqual([ID_A]);
  });

  it("propagates trusted-origin revocations as tombstones", () => {
    const local = {
      books: [],
      progress: [],
      trusted: [trusted("https://a.test", 4, 8), trusted("https://b.test", 2)],
    };
    const peer = buildManifest({
      books: [],
      progress: [],
      trusted: [trusted("https://a.test", 4), trusted("https://b.test", 3)],
    });
    expect(
      planSync(local, peer).sendTrusted.map((item) => item.origin)
    ).toEqual(["https://a.test"]);
  });
});

describe("mergeBookRecord", () => {
  it("takes the newer record but keeps addedAt and the latest lastOpenedAt", () => {
    const local = { ...book(ID_A, 5), addedAt: 1, lastOpenedAt: 50 };
    const incoming = {
      ...book(ID_A, 9),
      addedAt: 3,
      lastOpenedAt: 20,
      title: "Renamed",
    };
    expect(mergeBookRecord(local, incoming)).toEqual({
      ...incoming,
      addedAt: 1,
      lastOpenedAt: 50,
    });
    expect(mergeBookRecord(incoming, local)).toBeNull();
    expect(mergeBookRecord(local, { ...incoming, deletedAt: 9 })).toBeNull();
  });
});
