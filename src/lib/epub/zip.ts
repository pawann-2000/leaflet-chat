/**
 * Minimal ZIP central-directory reader.
 *
 * EPUB files are plain ZIP archives. Reading the central directory once lets
 * the importer and the service worker pull single entries out of the stored
 * blob on demand instead of inflating the whole archive into memory. Only the
 * two compression methods EPUB permits are supported: stored (0) and deflate
 * (8). Zip64 archives are rejected; the security limits already cap files far
 * below the 4 GiB where Zip64 becomes necessary.
 */
import { inflateSync } from "fflate";

export interface ZipEntry {
  compressedSize: number;
  /** Local header offset inside the archive. */
  headerOffset: number;
  method: 0 | 8;
  /** Archive path, exactly as stored (forward slashes, no leading slash). */
  name: string;
  size: number;
}

export interface ZipDirectory {
  entries: ZipEntry[];
  entryCount: number;
}

export class ZipError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ZipError";
    this.code = code;
  }
}

const EOCD_SIGNATURE = 0x06_05_4b_50;
const CENTRAL_SIGNATURE = 0x02_01_4b_50;
const LOCAL_SIGNATURE = 0x04_03_4b_50;
const ZIP64_LOCATOR_SIGNATURE = 0x07_06_4b_50;
const EOCD_MIN_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xff_ff;
const ZIP64_MARKER = 0xff_ff_ff_ff;

const decoder = new TextDecoder("utf-8", { fatal: false });

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

const badDirectory = () =>
  new ZipError("bad_directory", "the ZIP central directory is invalid");

interface CentralDirectory {
  entryCount: number;
  /** Offset of the end-of-central-directory record. */
  eocd: number;
  offset: number;
}

/** Find the end-of-central-directory record by scanning back over the comment. */
function locateCentralDirectory(archive: Uint8Array): CentralDirectory {
  const data = view(archive);
  const searchFloor = Math.max(
    0,
    archive.length - EOCD_MIN_LENGTH - MAX_COMMENT_LENGTH
  );
  let eocd = -1;
  for (
    let offset = archive.length - EOCD_MIN_LENGTH;
    offset >= searchFloor;
    offset -= 1
  ) {
    if (data.getUint32(offset, true) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) {
    throw new ZipError("not_zip", "the file is not a ZIP archive");
  }
  if (
    eocd >= 20 &&
    data.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIGNATURE
  ) {
    throw new ZipError("zip64", "Zip64 archives are not supported");
  }
  const disk = data.getUint16(eocd + 4, true);
  const directoryDisk = data.getUint16(eocd + 6, true);
  const entryCount = data.getUint16(eocd + 10, true);
  const size = data.getUint32(eocd + 12, true);
  const offset = data.getUint32(eocd + 16, true);
  if (disk !== 0 || directoryDisk !== 0) {
    throw new ZipError("multi_disk", "multi-part archives are not supported");
  }
  if (offset === ZIP64_MARKER || offset + size > eocd) {
    throw badDirectory();
  }
  return { eocd, entryCount, offset };
}

/** Parse one central-directory record; returns the entry (or null for a directory) and the next cursor. */
function parseCentralEntry(
  archive: Uint8Array,
  cursor: number,
  limit: number
): { entry: ZipEntry | null; next: number } {
  const data = view(archive);
  if (
    cursor + 46 > limit ||
    data.getUint32(cursor, true) !== CENTRAL_SIGNATURE
  ) {
    throw badDirectory();
  }
  const flags = data.getUint16(cursor + 8, true);
  const method = data.getUint16(cursor + 10, true);
  const compressedSize = data.getUint32(cursor + 20, true);
  const size = data.getUint32(cursor + 24, true);
  const nameLength = data.getUint16(cursor + 28, true);
  const extraLength = data.getUint16(cursor + 30, true);
  const commentLength = data.getUint16(cursor + 32, true);
  const headerOffset = data.getUint32(cursor + 42, true);
  const nameStart = cursor + 46;
  if (nameStart + nameLength > limit) {
    throw badDirectory();
  }
  const name = decoder.decode(
    archive.subarray(nameStart, nameStart + nameLength)
  );
  const next = nameStart + nameLength + extraLength + commentLength;

  // biome-ignore lint/suspicious/noBitwiseOperators: bit 0 of the flags is the encryption flag.
  if (flags & 0x1) {
    throw new ZipError("encrypted", "encrypted ZIP entries are not supported");
  }
  if (
    compressedSize === ZIP64_MARKER ||
    size === ZIP64_MARKER ||
    headerOffset === ZIP64_MARKER
  ) {
    throw new ZipError("zip64", "Zip64 archives are not supported");
  }
  if (!(method === 0 || method === 8)) {
    throw new ZipError(
      "unsupported_method",
      `unsupported ZIP compression method ${method}`
    );
  }
  // Directory entries carry no data; keep them out of the index entirely.
  const entry: ZipEntry | null = name.endsWith("/")
    ? null
    : { name, method, size, compressedSize, headerOffset };
  return { entry, next };
}

/** Locate and parse the central directory of a whole archive held in memory. */
export function readZipDirectory(archive: Uint8Array): ZipDirectory {
  const directory = locateCentralDirectory(archive);
  const entries: ZipEntry[] = [];
  let cursor = directory.offset;
  for (let index = 0; index < directory.entryCount; index += 1) {
    const { entry, next } = parseCentralEntry(archive, cursor, directory.eocd);
    cursor = next;
    if (entry) {
      entries.push(entry);
    }
  }
  return { entries, entryCount: directory.entryCount };
}

/**
 * Byte range of an entry's compressed payload, resolved from its local header.
 * The local header repeats the name and may carry a different extra-field
 * length than the central directory, so it has to be read before slicing.
 */
export function entryDataRange(
  archive: Uint8Array,
  entry: ZipEntry
): { start: number; end: number } {
  const data = view(archive);
  const offset = entry.headerOffset;
  if (
    offset + 30 > archive.length ||
    data.getUint32(offset, true) !== LOCAL_SIGNATURE
  ) {
    throw new ZipError("bad_entry", `the ZIP entry ${entry.name} is invalid`);
  }
  const nameLength = data.getUint16(offset + 26, true);
  const extraLength = data.getUint16(offset + 28, true);
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > archive.length) {
    throw new ZipError("bad_entry", `the ZIP entry ${entry.name} is truncated`);
  }
  return { start, end };
}

/** Inflate (or copy) an entry's payload bytes into its uncompressed form. */
export function decodeEntryData(
  entry: ZipEntry,
  payload: Uint8Array
): Uint8Array {
  const bytes =
    entry.method === 0
      ? payload.slice()
      : inflateSync(payload, { out: new Uint8Array(entry.size) });
  if (bytes.length !== entry.size) {
    throw new ZipError(
      "bad_entry",
      `the ZIP entry ${entry.name} has an unexpected size`
    );
  }
  return bytes;
}

/** Read one entry from an archive held fully in memory. */
export function readEntry(archive: Uint8Array, entry: ZipEntry): Uint8Array {
  const { start, end } = entryDataRange(archive, entry);
  return decodeEntryData(entry, archive.subarray(start, end));
}

/**
 * Read one entry from an archive kept as a `Blob`, touching only the bytes
 * that entry needs. This is the path the service worker uses.
 */
export async function readEntryFromBlob(
  blob: Blob,
  entry: ZipEntry
): Promise<Uint8Array> {
  const headerBytes = new Uint8Array(
    await blob.slice(entry.headerOffset, entry.headerOffset + 30).arrayBuffer()
  );
  if (
    headerBytes.length < 30 ||
    view(headerBytes).getUint32(0, true) !== LOCAL_SIGNATURE
  ) {
    throw new ZipError("bad_entry", `the ZIP entry ${entry.name} is invalid`);
  }
  const header = view(headerBytes);
  const nameLength = header.getUint16(26, true);
  const extraLength = header.getUint16(28, true);
  const start = entry.headerOffset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > blob.size) {
    throw new ZipError("bad_entry", `the ZIP entry ${entry.name} is truncated`);
  }
  const payload = new Uint8Array(await blob.slice(start, end).arrayBuffer());
  return decodeEntryData(entry, payload);
}

export function decodeText(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}
