import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  bookResourcePrefix,
  bookResourceUrl,
  parseBookResourcePath,
  parseBookResourceUrl,
} from "./urls";
import {
  decodeText,
  readEntry,
  readEntryFromBlob,
  readZipDirectory,
  ZipError,
} from "./zip";

describe("zip directory", () => {
  const archive = zipSync({
    "a.txt": [strToU8("stored"), { level: 0 }],
    "dir/b.txt": strToU8("deflated ".repeat(200)),
    "dir/": new Uint8Array(0),
  });

  it("lists file entries with methods and sizes", () => {
    const directory = readZipDirectory(archive);
    const names = directory.entries.map((entry) => entry.name);
    expect(names).toContain("a.txt");
    expect(names).toContain("dir/b.txt");
    expect(names).not.toContain("dir/");
    const stored = directory.entries.find((entry) => entry.name === "a.txt");
    expect(stored?.method).toBe(0);
    expect(stored?.size).toBe(6);
    const deflated = directory.entries.find(
      (entry) => entry.name === "dir/b.txt"
    );
    expect(deflated?.method).toBe(8);
    expect(deflated?.size).toBe(1800);
    expect(deflated && deflated.compressedSize < deflated.size).toBe(true);
  });

  it("reads entries from memory and from a blob", async () => {
    const directory = readZipDirectory(archive);
    const deflated = directory.entries.find(
      (entry) => entry.name === "dir/b.txt"
    );
    const stored = directory.entries.find((entry) => entry.name === "a.txt");
    if (!(deflated && stored)) {
      throw new Error("entries missing");
    }
    expect(decodeText(readEntry(archive, deflated))).toBe(
      "deflated ".repeat(200)
    );
    expect(decodeText(readEntry(archive, stored))).toBe("stored");
    const blob = new Blob([archive as BlobPart]);
    expect(decodeText(await readEntryFromBlob(blob, deflated))).toBe(
      "deflated ".repeat(200)
    );
    expect(decodeText(await readEntryFromBlob(blob, stored))).toBe("stored");
  });

  it("rejects non-zip data and truncated archives", () => {
    expect(() => readZipDirectory(strToU8("nope"))).toThrow(ZipError);
    const directory = readZipDirectory(archive);
    const truncated = archive.subarray(0, 10);
    const entry = directory.entries[1];
    expect(() => readEntry(truncated, entry)).toThrow(ZipError);
  });
});

describe("book resource urls", () => {
  const id = "a".repeat(64);

  it("round-trips archive paths", () => {
    const url = bookResourceUrl(id, "/EPUB/images/my cover.jpg");
    expect(url.startsWith(bookResourcePrefix(id))).toBe(true);
    expect(url).toContain("my%20cover.jpg");
    expect(parseBookResourceUrl(url)).toEqual({
      bookId: id,
      resourcePath: "/EPUB/images/my cover.jpg",
    });
  });

  it("rejects malformed paths", () => {
    expect(parseBookResourcePath("/book/")).toBeNull();
    expect(parseBookResourcePath(`/book/${id}`)).toBeNull();
    expect(parseBookResourcePath(`/book/${id}/`)).toBeNull();
    expect(parseBookResourcePath(`/book/${id}/a/../b`)).toBeNull();
    expect(parseBookResourcePath(`/book/${id}/a//b`)).toBeNull();
    expect(parseBookResourcePath(`/book/${id}/%zz`)).toBeNull();
    expect(parseBookResourcePath("/book/notahash/a.png")).toBeNull();
    expect(parseBookResourcePath("/other/x")).toBeNull();
    expect(parseBookResourceUrl("https://elsewhere.example/book/x")).toBeNull();
  });
});
