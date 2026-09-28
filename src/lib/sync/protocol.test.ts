import { describe, expect, it } from "vitest";
import type {
  BookFileRecord,
  BookRecord,
  BookRenderRecord,
} from "@/lib/db/types";
import type { SyncChannel } from "./channel";
import { sha256Hex } from "./encoding";
import { SyncError } from "./errors";
import { type ImportEpubFn, runSyncProtocol } from "./protocol";
import { FakeStore } from "./testing/fake-store";
import type { SyncEvent } from "./types";

/** Two in-memory channel ends; delivery is asynchronous and ordered. */
function channelPair(): [SyncChannel, SyncChannel] {
  const make = (): SyncChannel & {
    peer?: SyncChannel;
    deliver(data: string | ArrayBuffer): void;
  } => {
    let closed = false;
    const end = {
      peer: undefined as SyncChannel | undefined,
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      onbufferedamountlow: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      send(data: string | ArrayBuffer) {
        if (closed) {
          throw new Error("closed");
        }
        const copy = typeof data === "string" ? data : data.slice(0);
        const peer = end.peer as ReturnType<typeof make> | undefined;
        setTimeout(() => peer?.deliver(copy), 0);
      },
      deliver(data: string | ArrayBuffer) {
        if (!closed) {
          end.onmessage?.(data);
        }
      },
      close() {
        if (closed) {
          return;
        }
        closed = true;
        const peer = end.peer as ReturnType<typeof make> | undefined;
        setTimeout(() => peer?.onclose?.(), 0);
      },
    } as SyncChannel & {
      peer?: SyncChannel;
      deliver(data: string | ArrayBuffer): void;
    };
    return end;
  };
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

function record(id: string, overrides: Partial<BookRecord> = {}): BookRecord {
  return {
    addedAt: 100,
    authors: ["Author"],
    chapterCount: 2,
    coverPath: null,
    deletedAt: null,
    fileName: `${id.slice(0, 6)}.epub`,
    id,
    language: "en",
    lastOpenedAt: 100,
    pageDirection: "default",
    size: 0,
    title: `Book ${id.slice(0, 4)}`,
    updatedAt: 100,
    ...overrides,
  };
}

function fileRecord(
  id: string,
  bytes: Uint8Array<ArrayBuffer>
): BookFileRecord {
  return {
    id,
    blob: new Blob([bytes]),
    entries: [],
    fontKey: null,
    resources: {},
  };
}

function renderRecord(id: string): BookRenderRecord {
  return {
    id,
    chapters: [],
    documents: [],
    links: {},
    navigation: [],
    navigationTargets: {},
    spinePaths: [],
    renderVersion: 1,
    summaries: [],
  };
}

const importEpub: ImportEpubFn = async (source, fileName) => {
  const bytes = new Uint8Array(await source.arrayBuffer());
  const id = await sha256Hex(bytes);
  return {
    book: record(id, { fileName, size: bytes.length, updatedAt: 1 }),
    file: fileRecord(id, bytes),
    render: renderRecord(id),
  };
};

const CORRUPTED = /corrupted/u;
const noop = (): undefined => undefined;

async function storedBytes(store: FakeStore, id: string): Promise<Uint8Array> {
  const file = store.files.get(id);
  if (!file) {
    throw new Error(`no file stored for ${id}`);
  }
  return new Uint8Array(await file.blob.arrayBuffer());
}

async function bookBytes(seed: number, length: number) {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * 31 + seed) % 256;
  }
  return { bytes, id: await sha256Hex(bytes) };
}

function run(
  store: FakeStore,
  channel: SyncChannel,
  self: string,
  peer: string,
  events: SyncEvent[]
) {
  return runSyncProtocol({
    channel,
    store,
    self: { deviceId: self, name: self },
    peer: { deviceId: peer, name: peer },
    sas: "123456",
    sasConfirmed: Promise.resolve(),
    importEpub,
    emit: (event) => events.push(event),
    inactivityMs: 5000,
  });
}

describe("sync protocol", () => {
  it("converges two stores: books, progress and trusted origins", async () => {
    const a = new FakeStore();
    const b = new FakeStore();
    const big = await bookBytes(1, 40_000);
    const small = await bookBytes(2, 300);
    await a.putBook(
      record(big.id, { size: big.bytes.length, lastOpenedAt: 500 })
    );
    await a.putBookFile(fileRecord(big.id, big.bytes));
    await b.putBook(record(small.id, { size: small.bytes.length }));
    await b.putBookFile(fileRecord(small.id, small.bytes));
    await a.putProgress({
      bookId: big.id,
      chapterIndex: 3,
      progress: 0.4,
      updatedAt: 900,
    });
    await b.putProgress({
      bookId: big.id,
      chapterIndex: 1,
      progress: 0.1,
      updatedAt: 200,
    });
    await b.putProgress({
      bookId: small.id,
      chapterIndex: 0,
      progress: 0.9,
      updatedAt: 300,
    });
    await a.trustOrigin("https://a.test", 1000);
    await b.trustOrigin("https://b.test", 1000);
    await b.revokeOrigin("https://b.test", 2000);

    const [left, right] = channelPair();
    const eventsA: SyncEvent[] = [];
    const eventsB: SyncEvent[] = [];
    const runA = run(a, left, "A", "B", eventsA);
    const runB = run(b, right, "B", "A", eventsB);
    const [resultA, resultB] = await Promise.all([runA.done, runB.done]);

    expect(resultA.summary).toEqual({
      booksReceived: 1,
      booksSent: 1,
      progressReceived: 1,
      progressSent: 1,
      trustedReceived: 1,
      trustedSent: 1,
    });
    expect(resultB.summary).toEqual({
      booksReceived: 1,
      booksSent: 1,
      progressReceived: 1,
      progressSent: 1,
      trustedReceived: 1,
      trustedSent: 1,
    });

    expect(await storedBytes(b, big.id)).toEqual(big.bytes);
    expect(b.books.get(big.id)?.lastOpenedAt).toBe(500);
    expect(b.books.get(big.id)?.addedAt).toBe(100);
    expect(b.renders.has(big.id)).toBe(true);
    expect(await storedBytes(a, small.id)).toEqual(small.bytes);

    expect(b.progress.get(big.id)).toMatchObject({
      chapterIndex: 3,
      updatedAt: 900,
    });
    expect(a.progress.get(small.id)).toMatchObject({
      chapterIndex: 0,
      updatedAt: 300,
    });
    expect(await b.isOriginTrusted("https://a.test")).toBe(true);
    expect(a.trusted.get("https://b.test")?.deletedAt).toBe(2000);

    expect(eventsA.some((event) => event.type === "connected")).toBe(true);
    expect(
      eventsA.filter((event) => event.type === "transfer").length
    ).toBeGreaterThan(2);
    expect(eventsA.at(-1)?.type).toBe("complete");
    expect(eventsB.at(-1)?.type).toBe("complete");
  });

  it("propagates a newer deletion and newer metadata without moving bytes", async () => {
    const a = new FakeStore();
    const b = new FakeStore();
    const shared = await bookBytes(3, 100);
    const gone = await bookBytes(4, 100);
    await a.putBook(
      record(shared.id, { updatedAt: 900, title: "Renamed", lastOpenedAt: 900 })
    );
    await a.putBookFile(fileRecord(shared.id, shared.bytes));
    await b.putBook(record(shared.id, { updatedAt: 100 }));
    await b.putBookFile(fileRecord(shared.id, shared.bytes));
    await a.putBook(record(gone.id, { updatedAt: 50 }));
    await a.putBookFile(fileRecord(gone.id, gone.bytes));
    await b.putBook(record(gone.id, { updatedAt: 500, deletedAt: 500 }));

    const [left, right] = channelPair();
    const runA = run(a, left, "A", "B", []);
    const runB = run(b, right, "B", "A", []);
    const [resultA, resultB] = await Promise.all([runA.done, runB.done]);

    expect(resultA.summary.booksSent + resultB.summary.booksSent).toBe(0);
    expect(b.books.get(shared.id)).toMatchObject({
      title: "Renamed",
      updatedAt: 900,
      addedAt: 100,
    });
    expect(a.books.get(gone.id)?.deletedAt).toBe(500);
    expect(a.files.has(gone.id)).toBe(false);
  });

  it("discards a book whose bytes do not match its id and still completes", async () => {
    const a = new FakeStore();
    const b = new FakeStore();
    const real = await bookBytes(5, 500);
    const fakeId = "f".repeat(64);
    await a.putBook(record(fakeId, { size: real.bytes.length }));
    await a.putBookFile(fileRecord(fakeId, real.bytes));

    const [left, right] = channelPair();
    const eventsB: SyncEvent[] = [];
    const runA = run(a, left, "A", "B", []);
    const runB = run(b, right, "B", "A", eventsB);
    const [, resultB] = await Promise.all([runA.done, runB.done]);

    expect(resultB.summary.booksReceived).toBe(0);
    expect(b.books.has(fakeId)).toBe(false);
    expect(b.files.size).toBe(0);
    expect(
      eventsB.some(
        (event) => event.type === "error" && CORRUPTED.test(event.message)
      )
    ).toBe(true);
    expect(eventsB.at(-1)?.type).toBe("complete");
  });

  it("aborts when the peer's hello carries a different SAS", async () => {
    const a = new FakeStore();
    const b = new FakeStore();
    const [left, right] = channelPair();
    const eventsA: SyncEvent[] = [];
    const runA = run(a, left, "A", "B", eventsA);
    const runB = runSyncProtocol({
      channel: right,
      store: b,
      self: { deviceId: "B", name: "B" },
      peer: { deviceId: "A", name: "A" },
      sas: "654321",
      sasConfirmed: Promise.resolve(),
      importEpub,
      emit: noop,
      inactivityMs: 5000,
    });
    await expect(runA.done).rejects.toThrowError(SyncError);
    await expect(runB.done).rejects.toThrowError(SyncError);
    expect(eventsA.some((event) => event.type === "error")).toBe(true);
  });

  it("aborts when the peer is not the device from the pairing code", async () => {
    const [left, right] = channelPair();
    const runA = run(new FakeStore(), left, "A", "B", []);
    const runB = run(new FakeStore(), right, "C", "A", []);
    await expect(runA.done).rejects.toMatchObject({ code: "peer_mismatch" });
    await expect(runB.done).rejects.toThrowError(SyncError);
  });

  it("times out when the other side goes quiet", async () => {
    const [left] = channelPair();
    const runA = runSyncProtocol({
      channel: left,
      store: new FakeStore(),
      self: { deviceId: "A", name: "A" },
      peer: { deviceId: "B", name: "B" },
      sas: "123456",
      sasConfirmed: Promise.resolve(),
      importEpub,
      emit: noop,
      inactivityMs: 30,
    });
    await expect(runA.done).rejects.toMatchObject({ code: "timeout" });
  });
});
