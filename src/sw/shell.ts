/**
 * App-shell caching decisions for the service worker, kept free of the
 * worker globals so they can be unit-tested.
 *
 * Request kinds:
 *
 * - `book`         `/book/<id>/<path>` — answered from IndexedDB, never cached.
 * - `share-target` `POST /share-target` — an EPUB shared from another app.
 * - `asset`        `/assets/*` — hashed, immutable: cache-first.
 * - `static`       manifest and icons — stale-while-revalidate.
 * - `navigation`   HTML routes (`/`, `/join`, …) — network-first, offline
 *                  fallback to the cached `index.html`.
 * - `passthrough`  everything else (cross-origin providers and relays, the
 *                  worker script itself, dev-server modules).
 */

export type RequestKind =
  | "book"
  | "share-target"
  | "asset"
  | "static"
  | "navigation"
  | "passthrough";

/** Injected at build time; absent in dev. */
export interface ShellManifest {
  /** Absolute paths, e.g. `/assets/index-abc123.js`, `/index.html`. */
  assets: string[];
  version: string;
}

export interface RequestLike {
  headers?: { get(name: string): string | null };
  method: string;
  mode?: string;
  url: string;
}

export const SHELL_CACHE_PREFIX = "leaflet-shell-";
export const SHARE_TARGET_PATH = "/share-target";
/**
 * The shell document is cached under `/`, not `/index.html`: static hosts
 * such as Cloudflare Pages redirect `/index.html` to `/`, and a redirected
 * response cannot be served to a navigation from the cache.
 */
export const SHELL_INDEX = "/";
export const INBOX_REDIRECT = "/?inbox=1";
const NEVER_PRECACHED = new Set(["/book-sw.js", "/index.html"]);

const STATIC_PATHS = new Set(["/manifest.webmanifest"]);
const PASSTHROUGH_PREFIXES = ["/book-sw.js", "/src/", "/@", "/node_modules/"];

export function shellCacheName(version: string): string {
  return `${SHELL_CACHE_PREFIX}${version}`;
}

export function isShellCache(name: string): boolean {
  return name.startsWith(SHELL_CACHE_PREFIX);
}

function acceptsHtml(request: RequestLike): boolean {
  const accept = request.headers?.get("accept") ?? "";
  return accept.includes("text/html");
}

export function classifyRequest(
  request: RequestLike,
  origin: string
): RequestKind {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return "passthrough";
  }
  if (url.origin !== origin) {
    return "passthrough";
  }
  const { pathname } = url;
  if (pathname.startsWith("/book/")) {
    return "book";
  }
  if (pathname === SHARE_TARGET_PATH) {
    return request.method === "POST" ? "share-target" : "navigation";
  }
  if (request.method !== "GET") {
    return "passthrough";
  }
  if (PASSTHROUGH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return "passthrough";
  }
  if (pathname.startsWith("/assets/")) {
    return "asset";
  }
  if (STATIC_PATHS.has(pathname) || pathname.startsWith("/icons/")) {
    return "static";
  }
  if (request.mode === "navigate" || acceptsHtml(request)) {
    return "navigation";
  }
  return "passthrough";
}

/**
 * URLs to warm on install: the manifest's assets plus the shell document,
 * deduplicated and order-preserving. The worker script itself is never
 * listed (the browser owns its lifecycle).
 */
export function precacheUrls(manifest: ShellManifest): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const asset of [SHELL_INDEX, ...manifest.assets]) {
    const url = asset.startsWith("/") ? asset : `/${asset}`;
    if (NEVER_PRECACHED.has(url) || seen.has(url)) {
      continue;
    }
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

/** Only complete same-origin successes go into the cache. */
export function isCacheableResponse(response: {
  ok: boolean;
  status: number;
  type: string;
}): boolean {
  return (
    response.ok &&
    response.status === 200 &&
    (response.type === "basic" || response.type === "default")
  );
}

/**
 * A response that followed a redirect keeps `redirected: true`, and browsers
 * refuse to answer a navigation from the cache with such a response. Rebuild
 * it as a plain response before storing.
 */
export function storableResponse(response: Response): Response {
  if (!response.redirected) {
    return response;
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

const EPUB_TYPE = "application/epub+zip";

/** Files from a share-target form that look like EPUBs. */
export function shareTargetFiles(entries: FormDataEntryValue[]): File[] {
  return entries.filter(
    (entry): entry is File =>
      typeof entry !== "string" &&
      (entry.type === EPUB_TYPE || entry.name.toLowerCase().endsWith(".epub"))
  );
}
