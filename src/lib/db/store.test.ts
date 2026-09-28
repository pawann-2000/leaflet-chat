import { Blob as NodeBlob } from "node:buffer";
import { openDB } from "idb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLeafletStore, resetLeafletStore } from "@/lib/db";
import {
  type BookRecord,
  DB_NAME,
  DB_VERSION,
  type LeafletStore,
  type ProgressRecord,
  type ReadingDayRecord,
  type ReadingSessionRecord,
  type TrustedOriginRecord,
} from "@/lib/db/types";

const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);

function book(id: string, overrides: Partial<BookRecord> = {}): BookRecord {
  return {
    id,
    title: `Book ${id[0]}`,
    authors: ["Author"],
    language: "en",
    pageDirection: "default",
    chapterCount: 3,
    coverPath: "/EPUB/cover.jpg",
    fileName: "book.epub",
    size: 1024,
    addedAt: 1000,
    lastOpenedAt: 1000,
    updatedAt: 1000,
    deletedAt: null,
    ...overrides,
  };
}

function progress(
  bookId: string,
  updatedAt: number,
  chapterIndex = 1
): ProgressRecord {
  return { bookId, chapterIndex, progress: 0.5, updatedAt };
}

function origin(
  name: string,
  updatedAt: number,
  deletedAt: number | null = null
): TrustedOriginRecord {
  return {
    origin: name,
    trustedAt: Math.floor(updatedAt / 1000),
    updatedAt,
    deletedAt,
  };
}

describe("LeafletStore", () => {
  let store: LeafletStore;

  beforeEach(async () => {
    await resetLeafletStore();
    store = await openLeafletStore();
  });

  afterEach(async () => {
    await resetLeafletStore();
  });

  it("returns the same store for repeated opens", async () => {
    expect(await openLeafletStore()).toBe(store);
  });

  it("lists live books newest-opened first with cover URLs", async () => {
    await store.putBook(book(ID_A, { lastOpenedAt: 10 }));
    await store.putBook(book(ID_B, { lastOpenedAt: 20, coverPath: null }));
    const listed = await store.listBooks();
    expect(listed.map((item) => item.id)).toEqual([ID_B, ID_A]);
    expect(listed[1].coverDataUrl).toBe(
      `${location.origin}/book/${ID_A}/EPUB/cover.jpg`
    );
    expect(listed[0].coverDataUrl).toBeNull();
    expect(listed[0]).toMatchObject({
      title: "Book b",
      authors: ["Author"],
      chapterCount: 3,
      fileName: "book.epub",
      size: 1024,
    });
  });

  it("excludes tombstoned books from the shelf but keeps them in the manifest", async () => {
    await store.putBook(book(ID_A));
    await store.putBook(book(ID_B, { deletedAt: 5000, updatedAt: 5000 }));
    expect((await store.listBooks()).map((item) => item.id)).toEqual([ID_A]);
    expect(
      (await store.allBookRecords()).map((item) => item.id).sort()
    ).toEqual([ID_A, ID_B]);
  });

  it("touches lastOpenedAt without altering other fields", async () => {
    await store.putBook(book(ID_A));
    await store.touchBook(ID_A, 9999);
    expect(await store.getBook(ID_A)).toMatchObject({
      lastOpenedAt: 9999,
      updatedAt: 1000,
    });
    await store.touchBook(ID_B, 1);
    expect(await store.getBook(ID_B)).toBeUndefined();
  });

  it("round-trips book files as blobs and renders", async () => {
    // fake-indexeddb clones with Node's structuredClone, which only understands
    // Node's own Blob (jsdom's becomes `{}`). Browsers clone DOM Blobs natively.
    const blob = new NodeBlob([new Uint8Array([1, 2, 3])]) as unknown as Blob;
    await store.putBookFile({
      id: ID_A,
      blob,
      entries: [
        { name: "x", method: 0, size: 3, compressedSize: 3, headerOffset: 0 },
      ],
      fontKey: new Uint8Array(20),
      resources: {
        "/x": { mediaType: "text/css", transform: "none", zipIndex: 0 },
      },
    });
    const file = await store.getBookFile(ID_A);
    expect(file?.blob).toBeInstanceOf(NodeBlob);
    // biome-ignore lint/style/noNonNullAssertion: the instance assertion above guarantees the record.
    expect(new Uint8Array(await file!.blob.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3])
    );
    expect(file?.resources["/x"].mediaType).toBe("text/css");
    expect(file?.fontKey).toHaveLength(20);

    await store.putRender({
      id: ID_A,
      renderVersion: 1,
      chapters: [],
      summaries: [{ id: "c1", index: 0, title: "One" }],
      links: { "#leaflet-link-internal-x": "https://example.test/" },
      documents: [],
      navigation: [],
      navigationTargets: {},
      spinePaths: [],
    });
    expect((await store.getRender(ID_A))?.summaries[0].title).toBe("One");
  });

  it("deletes a book by tombstoning it and dropping its bytes, render, and progress", async () => {
    await store.putBook(book(ID_A));
    await store.putBookFile({
      id: ID_A,
      blob: new Blob([]),
      entries: [],
      fontKey: null,
      resources: {},
    });
    await store.putRender({
      id: ID_A,
      renderVersion: 1,
      chapters: [],
      summaries: [],
      links: {},
      documents: [],
      navigation: [],
      navigationTargets: {},
      spinePaths: [],
    });
    await store.putProgress(progress(ID_A, 1));

    await store.deleteBook(ID_A, 7777);

    expect(await store.getBook(ID_A)).toMatchObject({
      deletedAt: 7777,
      updatedAt: 7777,
    });
    expect(await store.getBookFile(ID_A)).toBeUndefined();
    expect(await store.getRender(ID_A)).toBeUndefined();
    expect(await store.getProgress(ID_A)).toBeUndefined();
    expect(await store.listBooks()).toEqual([]);
  });

  it("applies last-writer-wins to progress", async () => {
    expect(await store.putProgress(progress(ID_A, 100, 1))).toBe(true);
    expect(await store.putProgress(progress(ID_A, 50, 2))).toBe(false);
    expect(await store.putProgress(progress(ID_A, 100, 3))).toBe(false);
    expect(await store.putProgress(progress(ID_A, 150, 4))).toBe(true);
    expect((await store.getProgress(ID_A))?.chapterIndex).toBe(4);
    expect(await store.allProgress()).toHaveLength(1);
  });

  it("manages trusted origins with tombstones", async () => {
    await store.trustOrigin("https://a.example", 1000);
    await store.trustOrigin("https://b.example", 2000);
    expect(await store.isOriginTrusted("https://a.example")).toBe(true);
    expect(
      (await store.listTrustedOrigins()).map((item) => item.origin)
    ).toEqual(["https://b.example", "https://a.example"]);

    await store.revokeOrigin("https://a.example", 3000);
    expect(await store.isOriginTrusted("https://a.example")).toBe(false);
    expect(
      (await store.listTrustedOrigins()).map((item) => item.origin)
    ).toEqual(["https://b.example"]);
    expect(await store.allTrustedOriginRecords()).toHaveLength(2);

    // Trusting again revives the tombstoned record.
    await store.trustOrigin("https://a.example", 4000);
    expect(await store.isOriginTrusted("https://a.example")).toBe(true);

    await store.revokeAllOrigins(5000);
    expect(await store.listTrustedOrigins()).toEqual([]);
    expect(
      (await store.allTrustedOriginRecords()).every(
        (item) => item.deletedAt === 5000
      )
    ).toBe(true);
  });

  it("applies last-writer-wins to trusted origin records", async () => {
    expect(
      await store.putTrustedOriginRecord(origin("https://x.example", 100))
    ).toBe(true);
    expect(
      await store.putTrustedOriginRecord(origin("https://x.example", 90, 90))
    ).toBe(false);
    expect(
      await store.putTrustedOriginRecord(origin("https://x.example", 100, 100))
    ).toBe(false);
    expect(
      await store.putTrustedOriginRecord(origin("https://x.example", 200, 200))
    ).toBe(true);
    expect(await store.isOriginTrusted("https://x.example")).toBe(false);
  });

  it("stores peers", async () => {
    await store.putPeer({
      deviceId: "peer-1",
      name: "Phone",
      pairedAt: 1,
      lastSyncAt: null,
      publicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    });
    expect((await store.listPeers()).map((peer) => peer.name)).toEqual([
      "Phone",
    ]);
    await store.deletePeer("peer-1");
    expect(await store.listPeers()).toEqual([]);
  });

  it("stores typed settings", async () => {
    await store.putSetting("syncRelayUrl", "wss://relay.example");
    expect(await store.getSetting("syncRelayUrl")).toBe("wss://relay.example");
    await store.putSetting("provider", {
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      apiKey: null,
      allowRemote: true,
      kind: "openai-compatible",
    });
    expect((await store.getSetting("provider"))?.kind).toBe(
      "openai-compatible"
    );
    await store.deleteSetting("syncRelayUrl");
    expect(await store.getSetting("syncRelayUrl")).toBeUndefined();
  });

  it("stores reading goal and speed reading preferences", async () => {
    await store.putSetting("readingGoal", { secondsPerDay: 1200 });
    await store.putSetting("speedReading", { wpm: 425, chunk: 2 });
    expect(await store.getSetting("readingGoal")).toEqual({
      secondsPerDay: 1200,
    });
    expect(await store.getSetting("speedReading")).toEqual({
      wpm: 425,
      chunk: 2,
    });
  });

  it("round-trips reading days and lists them from a date onwards", async () => {
    const day = (date: string, seconds: number): ReadingDayRecord => ({
      date,
      seconds,
      words: seconds * 3,
      pages: 1,
      bookIds: [ID_A],
      updatedAt: 1,
    });
    await store.putReadingDay(day("2026-09-27", 60));
    await store.putReadingDay(day("2026-09-25", 30));
    await store.putReadingDay(day("2026-09-28", 90));
    expect((await store.getReadingDay("2026-09-25"))?.seconds).toBe(30);
    expect(await store.getReadingDay("2026-09-26")).toBeUndefined();
    expect(
      (await store.listReadingDays("2026-09-26")).map((item) => item.date)
    ).toEqual(["2026-09-27", "2026-09-28"]);
    expect(await store.listReadingDays("2026-01-01")).toHaveLength(3);
    // A second put for the same day replaces the record.
    await store.putReadingDay(day("2026-09-27", 120));
    expect((await store.getReadingDay("2026-09-27"))?.seconds).toBe(120);
  });

  it("round-trips reading sessions in start order, optionally per book", async () => {
    const session = (
      id: string,
      bookId: string,
      startedAt: number
    ): ReadingSessionRecord => ({
      id,
      bookId,
      startedAt,
      endedAt: startedAt + 600_000,
      seconds: 600,
      words: 1500,
      pages: 6,
    });
    await store.putReadingSession(session("s2", ID_A, 2000));
    await store.putReadingSession(session("s1", ID_A, 1000));
    await store.putReadingSession(session("s3", ID_B, 3000));
    expect((await store.listReadingSessions()).map((item) => item.id)).toEqual([
      "s1",
      "s2",
      "s3",
    ]);
    expect(
      (await store.listReadingSessions(ID_A)).map((item) => item.id)
    ).toEqual(["s1", "s2"]);
    expect(await store.listReadingSessions("missing")).toEqual([]);
    // Flushing the same sitting again updates it in place.
    await store.putReadingSession({
      ...session("s1", ID_A, 1000),
      seconds: 900,
    });
    expect((await store.listReadingSessions(ID_A))[0].seconds).toBe(900);
  });
});

describe("LeafletStore upgrades", () => {
  beforeEach(async () => {
    await resetLeafletStore();
  });

  afterEach(async () => {
    await resetLeafletStore();
  });

  it("upgrades a v1 database in place and keeps its books", async () => {
    expect(DB_VERSION).toBeGreaterThan(1);
    // The layout as v1 shipped: no reading ledger.
    const legacy = await openDB(DB_NAME, 1, {
      upgrade(database) {
        const books = database.createObjectStore("books", { keyPath: "id" });
        books.createIndex("by-lastOpened", "lastOpenedAt");
        database.createObjectStore("bookFiles", { keyPath: "id" });
        database.createObjectStore("bookRenders", { keyPath: "id" });
        database.createObjectStore("progress", { keyPath: "bookId" });
        const origins = database.createObjectStore("trustedOrigins", {
          keyPath: "origin",
        });
        origins.createIndex("by-trustedAt", "trustedAt");
        database.createObjectStore("peers", { keyPath: "deviceId" });
        database.createObjectStore("settings", { keyPath: "key" });
      },
    });
    await legacy.put("books", book(ID_A, { title: "Kept" }));
    await legacy.put("progress", progress(ID_A, 5, 2));
    await legacy.put("settings", {
      key: "syncRelayUrl",
      value: "wss://relay.example",
    });
    expect(legacy.objectStoreNames.contains("readingDays")).toBe(false);
    legacy.close();

    const store = await openLeafletStore();
    expect((await store.getBook(ID_A))?.title).toBe("Kept");
    expect((await store.getProgress(ID_A))?.chapterIndex).toBe(2);
    expect(await store.getSetting("syncRelayUrl")).toBe("wss://relay.example");
    await store.putReadingDay({
      date: "2026-09-28",
      seconds: 10,
      words: 20,
      pages: 1,
      bookIds: [ID_A],
      updatedAt: 1,
    });
    expect((await store.getReadingDay("2026-09-28"))?.words).toBe(20);
    await store.putReadingSession({
      id: "s1",
      bookId: ID_A,
      startedAt: 1,
      endedAt: 2,
      seconds: 1,
      words: 0,
      pages: 0,
    });
    expect(await store.listReadingSessions(ID_A)).toHaveLength(1);
  });
});
