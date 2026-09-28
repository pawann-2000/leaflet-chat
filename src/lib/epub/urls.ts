/**
 * Book resource URLs.
 *
 * The desktop app serves publication assets through a custom `leaflet-book://`
 * protocol. In the browser the same role is played by a same-origin path
 * prefix that a service worker answers from IndexedDB:
 *
 *   https://<app origin>/book/<book id>/<archive path>
 *
 * Chapter HTML is rewritten to these absolute URLs at render time, so the
 * reader, the publisher CSS loader and the link resolver only ever see this
 * one shape. Only manifest-declared render resources (CSS, images, fonts,
 * audio, video) are served; documents and everything else return 404.
 */

export const BOOK_RESOURCE_ROOT = "/book/";

export function bookResourceOrigin(): string {
  return typeof location === "undefined" ? "http://localhost" : location.origin;
}

/** `https://origin/book/<id>/` — every chapter path is appended to this. */
export function bookResourcePrefix(bookId: string): string {
  return `${bookResourceOrigin()}${BOOK_RESOURCE_ROOT}${bookId}/`;
}

const LEADING_SLASHES = /^\/+/u;

/** Absolute URL of an archive path such as `/EPUB/images/cover.jpg`. */
export function bookResourceUrl(bookId: string, archivePath: string): string {
  return `${bookResourcePrefix(bookId)}${encodeArchivePath(
    archivePath.replace(LEADING_SLASHES, "")
  )}`;
}

/** Percent-encode each path segment while keeping `/` separators. */
export function encodeArchivePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export interface BookResourceRef {
  bookId: string;
  /** Absolute archive path, decoded, e.g. `/EPUB/images/cover.jpg`. */
  resourcePath: string;
}

const BOOK_ID = /^[0-9a-f]{64}$/u;

/**
 * Parse a request path. Returns `null` unless it is `/book/<sha256 hex>/<path>`
 * with a non-empty, traversal-free resource path.
 */
export function parseBookResourcePath(
  pathname: string
): BookResourceRef | null {
  if (!pathname.startsWith(BOOK_RESOURCE_ROOT)) {
    return null;
  }
  const rest = pathname.slice(BOOK_RESOURCE_ROOT.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  const bookId = rest.slice(0, slash);
  if (!BOOK_ID.test(bookId)) {
    return null;
  }
  let resourcePath: string;
  try {
    resourcePath = rest
      .slice(slash + 1)
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    return null;
  }
  if (
    !resourcePath ||
    resourcePath.split("/").some((s) => s === ".." || s === "")
  ) {
    return null;
  }
  return { bookId, resourcePath: `/${resourcePath}` };
}

/**
 * Parse an absolute URL produced by `bookResourceUrl`. Returns `null` for any
 * other origin or shape.
 */
export function parseBookResourceUrl(url: string): BookResourceRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== bookResourceOrigin()) {
    return null;
  }
  return parseBookResourcePath(parsed.pathname);
}
