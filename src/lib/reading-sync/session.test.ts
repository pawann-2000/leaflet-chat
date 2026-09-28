import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IndexeddbPersistence } from "y-indexeddb";
import { Doc } from "yjs";
import { createReadingSession } from "./session";
import type { ContentLocator } from "./types";

const chapters = ["c1", "c2"];
const selection: ContentLocator = {
  chapterId: "c1",
  start: 3,
  end: 28,
  quote: "  A passage\n天地  ",
};
const fingerprint = (name: string): string =>
  createHash("sha256").update(name).digest("hex");
const noChange = (): void => undefined;

describe("reading session persistence", () => {
  it("persists notes, deletion, and private location across close and reopen", async () => {
    const errors: Error[] = [];
    const book = fingerprint("reading-session-persistence");
    const onError = (error: Error) => errors.push(error);
    const first = await createReadingSession(book, chapters, noChange, onError);
    first.add("highlight", selection);
    first.add(
      "comment",
      { ...selection, chapterId: "c2" },
      "Remember this 👩🏽‍💻"
    );
    first.add("bookmark", { ...selection, start: 8, end: 8, quote: "" });
    first.saveLocation({
      ...selection,
      chapterId: "c2",
      start: 8,
      end: 8,
      quote: "",
    });
    const expected = first.annotations;
    await first.destroy();

    const reopened = await createReadingSession(
      book,
      chapters,
      noChange,
      onError
    );
    expect(reopened.annotations).toEqual(expected);
    expect(reopened.savedLocation).toEqual({
      ...selection,
      chapterId: "c2",
      start: 8,
      end: 8,
      quote: "",
    });
    expect(reopened.room).toBeNull();
    expect(reopened.canAnnotate).toBe(true);
    expect(reopened.annotations[0].author?.id).toBe(reopened.readerId);
    reopened.remove(expected[0].id);
    const remaining = reopened.annotations;
    await reopened.destroy();

    const final = await createReadingSession(book, chapters, noChange, onError);
    expect(final.annotations).toEqual(remaining);
    expect(errors).toEqual([]);
    await final.destroy();
  });

  it("keeps the same chapter names in different books isolated", async () => {
    const leftBook = fingerprint("reading-book-a");
    const rightBook = fingerprint("reading-book-b");
    const left = await createReadingSession(
      leftBook,
      chapters,
      noChange,
      noChange
    );
    const right = await createReadingSession(
      rightBook,
      chapters,
      noChange,
      noChange
    );
    left.add("comment", selection, "Only book A");
    right.add("bookmark", { ...selection, start: 3, end: 3, quote: "" });
    await Promise.all([left.destroy(), right.destroy()]);
    const restoredLeft = await createReadingSession(
      leftBook,
      chapters,
      noChange,
      noChange
    );
    const restoredRight = await createReadingSession(
      rightBook,
      chapters,
      noChange,
      noChange
    );
    expect(restoredLeft.annotations.map((note) => note.kind)).toEqual([
      "comment",
    ]);
    expect(restoredRight.annotations.map((note) => note.kind)).toEqual([
      "bookmark",
    ]);
    await Promise.all([restoredLeft.destroy(), restoredRight.destroy()]);
  });

  it("does not let caller mutation change stored locators or returned annotations", async () => {
    const session = await createReadingSession(
      fingerprint("reading-caller-mutation"),
      chapters,
      noChange,
      noChange
    );
    const supplied = { ...selection };
    session.add("comment", supplied, "Original text");
    supplied.quote = "changed";
    const returned = session.annotations;
    returned[0].text = "changed";
    returned[0].locator.start = 99;
    expect(session.annotations[0].text).toBe("Original text");
    expect(session.annotations[0].locator).toEqual(selection);
    await session.destroy();
    expect(() => session.add("highlight", selection)).toThrow("closed");
  });

  it("rejects invalid local selections before changing durable annotations or positions", async () => {
    const book = fingerprint("reading-invalid-local");
    const session = await createReadingSession(
      book,
      chapters,
      noChange,
      noChange
    );
    session.add("bookmark", { ...selection, start: 3, end: 3, quote: "" });
    const before = session.annotations;
    expect(() => session.add("comment", selection, "   ")).toThrow(
      "Write a comment"
    );
    expect(() =>
      session.add("highlight", { ...selection, chapterId: "foreign" })
    ).toThrow("different chapter");
    expect(() => session.saveLocation({ ...selection, end: -1 })).toThrow();
    expect(session.annotations).toEqual(before);
    expect(session.savedLocation).toBeNull();
    await session.destroy();
    const reopened = await createReadingSession(
      book,
      chapters,
      noChange,
      noChange
    );
    expect(reopened.annotations).toEqual(before);
    expect(reopened.savedLocation).toBeNull();
    await reopened.destroy();
  });

  it("fails visibly for corrupt local checkpoints", async () => {
    const book = fingerprint("reading-corrupt-checkpoint");
    const doc = new Doc();
    const provider = new IndexeddbPersistence(
      `leaflet-reading-v1-${book}`,
      doc
    );
    await provider.whenSynced;
    await provider.set("checkpoint", "invalid old data");
    await provider.destroy();
    doc.destroy();
    await expect(
      createReadingSession(book, chapters, noChange, noChange)
    ).rejects.toThrow("checkpoint is invalid");
  });

  it("surfaces checkpoint write failures and blocks further edits", async () => {
    let signal!: () => void;
    const failed = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const errors: Error[] = [];
    const session = await createReadingSession(
      fingerprint("reading-quota-error"),
      chapters,
      noChange,
      (error) => {
        errors.push(error);
        signal();
      }
    );
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      value: unknown,
      key?: IDBValidKey
    ) {
      if (key === "checkpoint") {
        throw new DOMException(
          "Synthetic quota exhaustion",
          "QuotaExceededError"
        );
      }
      return original.call(this, value, key);
    };
    try {
      session.add("comment", selection, "A thought before storage failure");
      await failed;
      expect(errors[0].message).toContain("could not be saved");
      expect(session.status.toLowerCase()).toContain("storage failed");
      expect(() => session.add("highlight", selection)).toThrow(
        "storage is unavailable"
      );
      expect(() =>
        session.saveLocation({ ...selection, start: 8, end: 8, quote: "" })
      ).toThrow("storage is unavailable");
    } finally {
      IDBObjectStore.prototype.put = original;
      await session.destroy();
    }
  });
});
