import { strToU8, type Zippable, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { EpubError } from "./errors";
import {
  inspectEpub,
  MAX_ARCHIVE_ENTRIES,
  safeArchiveName,
  suspiciousCompression,
} from "./security";
import { buildEpub } from "./test-fixtures";

function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof EpubError) {
      return error.code;
    }
    throw error;
  }
  return "ok";
}

describe("archive preflight", () => {
  it("rejects unsafe archive names", () => {
    expect(safeArchiveName("../outside")).toBe(false);
    expect(safeArchiveName("EPUB/../../outside")).toBe(false);
    expect(safeArchiveName("/absolute/path")).toBe(false);
    expect(safeArchiveName("C:evil")).toBe(false);
    expect(safeArchiveName("EPUB\\text")).toBe(false);
    expect(safeArchiveName("EPUB//text")).toBe(false);
    expect(safeArchiveName("")).toBe(false);
    expect(safeArchiveName("EPUB/text/chapter.xhtml")).toBe(true);
    expect(safeArchiveName("./EPUB/text/chapter.xhtml")).toBe(true);
  });

  it("checks compression ratio without integer truncation", () => {
    expect(suspiciousCompression(500_000, 1000)).toBe(false);
    expect(suspiciousCompression(500_001, 1000)).toBe(true);
    expect(suspiciousCompression(500_001, 0)).toBe(false);
  });

  it("only accepts .epub file names", () => {
    const archive = buildEpub({});
    expect(code(() => inspectEpub("book.zip", archive))).toBe(
      "invalid_extension"
    );
    expect(code(() => inspectEpub("book.EPUB", archive))).toBe("ok");
  });

  it("rejects files that are not ZIP archives", () => {
    expect(code(() => inspectEpub("book.epub", strToU8("plain text")))).toBe(
      "parse"
    );
  });

  it("rejects traversal entries", () => {
    const archive = zipSync({ "../escape.txt": strToU8("x") });
    expect(code(() => inspectEpub("book.epub", archive))).toBe(
      "unsafe_archive_path"
    );
  });

  it("rejects suspicious compression ratios", () => {
    const zeros = new Uint8Array(2 * 1024 * 1024);
    const archive = zipSync({ "EPUB/bomb.bin": zeros }, { level: 9 });
    expect(code(() => inspectEpub("book.epub", archive))).toBe(
      "suspicious_compression"
    );
  });

  it("rejects archives with too many entries", () => {
    const files: Zippable = {};
    for (let index = 0; index <= MAX_ARCHIVE_ENTRIES; index += 1) {
      files[`e/${index}`] = [new Uint8Array(0), { level: 0 }];
    }
    const archive = zipSync(files);
    expect(code(() => inspectEpub("book.epub", archive))).toBe(
      "too_many_entries"
    );
  });

  it("returns the directory for a healthy archive", () => {
    const archive = buildEpub({ "EPUB/a.txt": "hello" });
    const directory = inspectEpub("book.epub", archive);
    expect(directory.entries.map((entry) => entry.name)).toEqual([
      "mimetype",
      "META-INF/container.xml",
      "EPUB/a.txt",
    ]);
    expect(directory.entries[0].method).toBe(0);
    expect(directory.entries[2].size).toBe(5);
  });
});
