import type { BookFileRecord } from "@/lib/db/types";
import { deobfuscateIdpfFont } from "@/lib/epub/idpf";
import { parseBookResourcePath } from "@/lib/epub/urls";
import { readEntryFromBlob } from "@/lib/epub/zip";

/**
 * Mirrors the desktop `protocol.rs`: a request must name a stored book and a
 * manifest-declared render resource. Everything else answers with an empty
 * error body that carries no detail about why.
 */
export const BOOK_RESOURCE_CSP =
  "default-src 'none'; sandbox; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self'";

export type BookFileLoader = (
  bookId: string
) => Promise<BookFileRecord | undefined>;

export function resourceError(status: number): Response {
  return new Response(null, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Answer a book-resource request, or return `null` when the request is not
 * addressed to the book protocol at all (other requests pass through).
 */
export async function handleBookRequest(
  request: Request,
  load: BookFileLoader
): Promise<Response | null> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (
    !url.pathname.startsWith("/book/") ||
    (typeof location !== "undefined" && url.origin !== location.origin)
  ) {
    return null;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return resourceError(405);
  }
  const ref = parseBookResourcePath(url.pathname);
  if (!ref) {
    return resourceError(400);
  }

  let record: BookFileRecord | undefined;
  try {
    record = await load(ref.bookId);
  } catch {
    return resourceError(500);
  }
  if (!record) {
    return resourceError(404);
  }
  const resource = record.resources[ref.resourcePath];
  if (!resource || resource.transform === "unsupported") {
    return resourceError(404);
  }
  const entry = record.entries[resource.zipIndex];
  if (!entry) {
    return resourceError(404);
  }
  if (resource.transform === "idpf-font" && !record.fontKey) {
    return resourceError(404);
  }

  let bytes: Uint8Array;
  try {
    bytes = await readEntryFromBlob(record.blob, entry);
  } catch {
    return resourceError(422);
  }
  if (resource.transform === "idpf-font" && record.fontKey) {
    deobfuscateIdpfFont(bytes, record.fontKey);
  }

  const headers = {
    "Cache-Control": "private, max-age=31536000, immutable",
    "Content-Length": String(bytes.byteLength),
    "Content-Security-Policy": BOOK_RESOURCE_CSP,
    "Content-Type": resource.mediaType,
    "X-Content-Type-Options": "nosniff",
  };
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(bytes as BodyInit, { status: 200, headers });
}
