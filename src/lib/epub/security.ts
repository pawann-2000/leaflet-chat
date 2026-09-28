/**
 * Archive preflight, ported from the `reader-security` crate.
 *
 * Every EPUB is untrusted. Before anything is parsed the ZIP directory is
 * checked against fixed limits so a malicious archive cannot exhaust memory
 * (ZIP bombs, oversized entries) or smuggle traversal paths into the resource
 * map. The browser never touches a filesystem, but the path rule is kept so
 * archive paths stay a closed, predictable namespace for the service worker.
 */
import { EpubError } from "./errors";
import { readZipDirectory, type ZipDirectory, ZipError } from "./zip";

export const MAX_EPUB_BYTES = 512 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 20_000;
export const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
export const MAX_COMPRESSION_RATIO = 500;

const DRIVE_PREFIX = /^[a-z]:/iu;
const EPUB_EXTENSION = /\.epub$/iu;

export function hasEpubExtension(fileName: string): boolean {
  return EPUB_EXTENSION.test(fileName);
}

export function suspiciousCompression(
  size: number,
  compressedSize: number
): boolean {
  return compressedSize > 0 && size > compressedSize * MAX_COMPRESSION_RATIO;
}

/**
 * Relative, forward-slash paths made only of normal segments (`.` allowed).
 * Rejects absolute paths, `..`, empty segments, backslashes and drive letters.
 */
export function safeArchiveName(name: string): boolean {
  if (
    !name ||
    name.startsWith("/") ||
    name.includes("\\") ||
    DRIVE_PREFIX.test(name)
  ) {
    return false;
  }
  return name.split("/").every((segment) => segment !== "" && segment !== "..");
}

/** Validate a whole archive and return its directory. Throws `EpubError`. */
export function inspectEpub(
  fileName: string,
  archive: Uint8Array
): ZipDirectory {
  if (!hasEpubExtension(fileName)) {
    throw new EpubError("invalid_extension");
  }
  if (archive.byteLength > MAX_EPUB_BYTES) {
    throw new EpubError("input_too_large");
  }

  let directory: ZipDirectory;
  try {
    directory = readZipDirectory(archive);
  } catch (error) {
    throw new EpubError(
      "parse",
      error instanceof ZipError ? error.message : "invalid EPUB archive"
    );
  }
  if (directory.entryCount > MAX_ARCHIVE_ENTRIES) {
    throw new EpubError("too_many_entries");
  }

  let total = 0;
  for (const entry of directory.entries) {
    if (!safeArchiveName(entry.name)) {
      throw new EpubError("unsafe_archive_path");
    }
    if (entry.size > MAX_ENTRY_BYTES) {
      throw new EpubError("entry_too_large");
    }
    total += entry.size;
    if (total > MAX_UNCOMPRESSED_BYTES) {
      throw new EpubError("archive_too_large");
    }
    if (suspiciousCompression(entry.size, entry.compressedSize)) {
      throw new EpubError("suspicious_compression");
    }
  }
  return directory;
}
