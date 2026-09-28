/// <reference lib="webworker" />
import { type IDBPDatabase, openDB } from "idb";
import type { LeafletDB } from "@/lib/db/schema";
import { type BookFileRecord, DB_NAME, DB_VERSION } from "@/lib/db/types";
import { addToInbox } from "@/lib/sw/inbox-db";
import { handleBookRequest } from "./handler";
import {
  classifyRequest,
  INBOX_REDIRECT,
  isCacheableResponse,
  isShellCache,
  precacheUrls,
  SHELL_INDEX,
  type ShellManifest,
  shareTargetFiles,
  shellCacheName,
  storableResponse,
} from "./shell";

/**
 * Leaflet service worker.
 *
 * 1. Book resource protocol — serves `/book/<id>/<path>` from the EPUB blobs
 *    the page stores in IndexedDB. The worker never upgrades that schema: if
 *    it finds itself opening a database the page has not created yet, or
 *    blocking a page's upgrade, it closes its connection and lets the next
 *    request reopen.
 * 2. App shell — precaches the built assets (list injected at build time as
 *    `__LEAFLET_PRECACHE__`; absent in dev, where nothing is cached) so the
 *    reader opens offline; hashed assets are cache-first, HTML routes are
 *    network-first with the cached shell as the offline fallback.
 * 3. Share target — `POST /share-target` from the OS share sheet stores the
 *    shared EPUB in the inbox database and redirects to the app.
 */
declare const self: ServiceWorkerGlobalScope;
declare const __LEAFLET_PRECACHE__: ShellManifest | undefined;

const shell: ShellManifest | null =
  typeof __LEAFLET_PRECACHE__ === "undefined" ? null : __LEAFLET_PRECACHE__;
const CACHE_NAME = shell ? shellCacheName(shell.version) : null;

let connection: Promise<IDBPDatabase<LeafletDB>> | undefined;

function forgetConnection(): void {
  connection = undefined;
}

function database(): Promise<IDBPDatabase<LeafletDB>> {
  connection ??= openDB<LeafletDB>(DB_NAME, DB_VERSION, {
    upgrade(db, _oldVersion, _newVersion, transaction) {
      // The page owns the schema. Abort so the store never exists in a
      // half-created state, and surface the failure to the caller.
      transaction.abort();
      db.close();
      forgetConnection();
    },
    blocking(_current, _blocked, event) {
      (event.target as IDBDatabase | null)?.close();
      forgetConnection();
    },
    terminated: forgetConnection,
  }).catch((error: unknown) => {
    forgetConnection();
    throw error;
  });
  return connection;
}

async function loadBookFile(
  bookId: string
): Promise<BookFileRecord | undefined> {
  const db = await database();
  return db.get("bookFiles", bookId);
}

// ---------------------------------------------------------------------------
// App shell

/**
 * Warm the new cache. Hashed assets that an older cache already holds are
 * copied instead of re-downloaded, so a deploy only fetches what changed.
 */
async function precacheShell(): Promise<void> {
  if (!(shell && CACHE_NAME)) {
    return;
  }
  const cache = await caches.open(CACHE_NAME);
  const failures: string[] = [];
  await Promise.all(
    precacheUrls(shell).map(async (url) => {
      const reusable = url.startsWith("/assets/")
        ? await caches.match(url)
        : undefined;
      if (reusable) {
        await cache.put(url, reusable);
        return;
      }
      try {
        const response = await fetch(url, { cache: "reload" });
        if (isCacheableResponse(response)) {
          await cache.put(url, storableResponse(response));
        } else {
          failures.push(url);
        }
      } catch {
        failures.push(url);
      }
    })
  );
  if (failures.includes(SHELL_INDEX)) {
    // Without the document the shell cannot open offline; let install fail
    // so the previous worker keeps serving until the network is back.
    throw new Error("The app shell could not be cached.");
  }
}

async function dropOldCaches(): Promise<void> {
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => isShellCache(name) && name !== CACHE_NAME)
      .map((name) => caches.delete(name))
  );
}

async function cacheFirst(request: Request): Promise<Response> {
  const cached = await caches.match(request, { ignoreSearch: false });
  if (cached) {
    return cached;
  }
  const response = await fetch(request);
  if (CACHE_NAME && isCacheableResponse(response)) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone()).catch(() => undefined);
  }
  return response;
}

async function staleWhileRevalidate(request: Request): Promise<Response> {
  const cached = await caches.match(request);
  const refresh = fetch(request)
    .then(async (response) => {
      if (CACHE_NAME && isCacheableResponse(response)) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => undefined);
  if (cached) {
    return cached;
  }
  const fresh = await refresh;
  return fresh ?? Response.error();
}

async function networkFirstDocument(request: Request): Promise<Response> {
  try {
    const response = await fetch(request);
    if (CACHE_NAME && isCacheableResponse(response)) {
      const cache = await caches.open(CACHE_NAME);
      cache
        .put(SHELL_INDEX, storableResponse(response.clone()))
        .catch(() => undefined);
    }
    return response;
  } catch (error) {
    const fallback = await caches.match(SHELL_INDEX);
    if (fallback) {
      return fallback;
    }
    throw error;
  }
}

async function receiveShare(request: Request): Promise<Response> {
  try {
    const form = await request.formData();
    const files = shareTargetFiles(form.getAll("book"));
    const stored = await addToInbox(files);
    return Response.redirect(stored ? INBOX_REDIRECT : "/", 303);
  } catch {
    return Response.redirect("/", 303);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(dropOldCaches().then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const kind = classifyRequest(event.request, self.location.origin);
  switch (kind) {
    case "book":
      event.respondWith(
        handleBookRequest(event.request, loadBookFile).then(
          (response) => response ?? fetch(event.request)
        )
      );
      return;
    case "share-target":
      event.respondWith(receiveShare(event.request));
      return;
    case "asset":
      if (shell) {
        event.respondWith(cacheFirst(event.request));
      }
      return;
    case "static":
      if (shell) {
        event.respondWith(staleWhileRevalidate(event.request));
      }
      return;
    case "navigation":
      if (shell) {
        event.respondWith(networkFirstDocument(event.request));
      }
      return;
    default:
      return;
  }
});
