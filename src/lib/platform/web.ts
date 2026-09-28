import {
  streamChat as providerChat,
  listModels as providerModels,
} from "@/lib/ai";
import { openLeafletStore } from "@/lib/db";
import {
  type BookFileRecord,
  type BookRecord,
  type BookRenderRecord,
  type LeafletStore,
  RENDER_VERSION,
} from "@/lib/db/types";
import type { Platform } from "@/lib/platform/types";
import { registerBookProtocol } from "@/lib/sw/register";
import type {
  ChatRequest,
  ExternalOpenMode,
  LinkTarget,
  OpenedPublication,
  ProviderConfig,
  TrustedSite,
} from "@/lib/types";

interface OpenBook {
  book: BookRecord;
  file: BookFileRecord;
  render: BookRenderRecord;
}

interface ExternalRequest {
  expiresAt: number;
  origin: string | null;
  url: string;
}

/**
 * The EPUB engine (parser, sanitizer, zip reader) is only needed once a book is
 * touched; loading it on demand keeps it out of the library's first paint.
 */
const epub = () => import("@/lib/epub");

/** How long a resolved external destination stays openable, like the Rust registry. */
const EXTERNAL_REQUEST_TTL = 5 * 60 * 1000;
const EPUB_MIME_TYPES = ".epub,application/epub+zip";
const CHAPTER_CACHE_COUNT = 3;
const CHAPTER_CACHE_CODE_UNITS = 8 * 1024 * 1024;

/**
 * Browser host: the whole pipeline runs in the page.
 *
 * - Books are parsed with `@/lib/epub` and kept in IndexedDB (`@/lib/db`).
 * - Publication assets are served by a service worker from those records.
 * - Provider calls go straight from the browser to the endpoint (BYOK).
 *
 * External-link handling mirrors the desktop: resolving a link yields a
 * one-use request id; only that id (never a caller-supplied URL) can be
 * opened, and the URL comes from the sanitized link registry of the open book.
 */
export async function createWebPlatform(): Promise<Platform> {
  const store = await openLeafletStore();
  const protocol = await registerBookProtocol();
  const open = new Map<string, OpenBook>();
  const externalRequests = new Map<string, ExternalRequest>();
  const recentChapters = new Map<string, number[]>();
  const pendingChapters = new Map<
    string,
    Promise<import("@/lib/types").Chapter>
  >();
  let renderTail: Promise<void> = Promise.resolve();

  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = renderTail.then(operation);
    renderTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  function rememberChapter(
    entry: OpenBook,
    index: number,
    chapter: import("@/lib/types").Chapter
  ): BookRenderRecord {
    const next: BookRenderRecord = {
      ...entry.render,
      chapters: [...entry.render.chapters],
      links: { ...entry.render.links },
    };
    const cost =
      chapter.html.length +
      chapter.plainText.length +
      chapter.inlineStyles.join("").length;
    const recent = (recentChapters.get(entry.book.id) ?? []).filter(
      (item) => item !== index
    );
    if (cost <= CHAPTER_CACHE_CODE_UNITS) {
      next.chapters[index] = chapter;
      recent.push(index);
    }
    while (
      recent.length > CHAPTER_CACHE_COUNT ||
      recent.reduce((sum, item) => {
        const cached = next.chapters[item];
        return (
          sum +
          (cached
            ? cached.html.length +
              cached.plainText.length +
              cached.inlineStyles.join("").length
            : 0)
        );
      }, 0) > CHAPTER_CACHE_CODE_UNITS
    ) {
      const oldest = recent.shift();
      if (oldest !== undefined) {
        delete next.chapters[oldest];
      }
    }
    recentChapters.set(entry.book.id, recent);
    return next;
  }

  function currentBook(bookId: string): OpenBook {
    const entry = open.get(bookId);
    if (!entry) {
      throw new Error("This book is no longer open.");
    }
    return entry;
  }

  function publish(entry: OpenBook): OpenedPublication {
    open.clear();
    externalRequests.clear();
    recentChapters.clear();
    recentChapters.set(
      entry.book.id,
      entry.render.chapters.flatMap((chapter, index) =>
        chapter ? [index] : []
      )
    );
    open.set(entry.book.id, entry);
    return published(entry);
  }

  async function published(entry: OpenBook): Promise<OpenedPublication> {
    return (await epub()).openedPublication(entry.book, entry.render);
  }

  async function openFile(file: File): Promise<OpenedPublication> {
    const imported = await (await epub()).importEpub(file, file.name);
    const now = Date.now();
    const existing = await store.getBook(imported.book.id);
    const book: BookRecord =
      existing && existing.deletedAt === null
        ? { ...existing, lastOpenedAt: now, updatedAt: now }
        : {
            ...imported.book,
            addedAt: now,
            lastOpenedAt: now,
            updatedAt: now,
            deletedAt: null,
          };
    await store.putBookFile(imported.file);
    await store.putRender(imported.render);
    await store.putBook(book);
    return publish({ book, file: imported.file, render: imported.render });
  }

  function takeExternalRequest(requestId: string): ExternalRequest {
    const request = externalRequests.get(requestId);
    externalRequests.delete(requestId);
    if (!request || request.expiresAt < Date.now()) {
      throw new Error("This link request has expired. Click the link again.");
    }
    return request;
  }

  return {
    kind: "web",
    capabilities: {
      library: true,
      providers: ["openai-compatible", "anthropic"],
      storedKeys: true,
      sync: true,
    },
    startupNotice: protocol.ok
      ? null
      : `Images and fonts inside books are unavailable in this browser session (${protocol.reason}).`,

    async chooseAndOpenBook() {
      const file = await pickFile(EPUB_MIME_TYPES);
      return file ? openFile(file) : null;
    },
    openBookFile: openFile,

    listLibrary: () => store.listBooks(),
    loadChapter(bookId, index) {
      const key = `${bookId}:${index}`;
      const pending = pendingChapters.get(key);
      if (pending) {
        return pending;
      }
      const task = serialized(async () => {
        const entry = currentBook(bookId);
        const cached = entry.render.chapters[index];
        if (cached && cached.index === index) {
          recentChapters.set(bookId, [
            ...(recentChapters.get(bookId) ?? []).filter(
              (item) => item !== index
            ),
            index,
          ]);
          return cached;
        }
        const draft: BookRenderRecord = {
          ...entry.render,
          chapters: [...entry.render.chapters],
          links: { ...entry.render.links },
        };
        const chapter = await (await epub()).renderStoredChapter(
          entry.book,
          entry.file,
          draft,
          index
        );
        const next = rememberChapter(
          { ...entry, render: draft },
          index,
          chapter
        );
        await store.putRender(next);
        entry.render = next;
        return chapter;
      });
      pendingChapters.set(key, task);
      // Observe either outcome without changing the promise returned to callers.
      task.then(
        () => {
          pendingChapters.delete(key);
        },
        () => {
          pendingChapters.delete(key);
        }
      );
      return task;
    },
    async openLibraryBook(id) {
      const [book, file, stored] = await Promise.all([
        store.getBook(id),
        store.getBookFile(id),
        store.getRender(id),
      ]);
      if (!(book && file) || book.deletedAt !== null) {
        throw new Error("This book is no longer in the library.");
      }
      let render = stored;
      if (!render || render.renderVersion !== RENDER_VERSION) {
        render = await (await epub()).renderStoredBook(book, file);
        await store.putRender(render);
      }
      const now = Date.now();
      await store.touchBook(id, now);
      return publish({ book: { ...book, lastOpenedAt: now }, file, render });
    },
    async removeLibraryBook(id) {
      open.delete(id);
      await store.deleteBook(id);
    },
    closeBook(bookId) {
      open.delete(bookId);
      recentChapters.delete(bookId);
      externalRequests.clear();
      return Promise.resolve();
    },

    async listProgress() {
      const records = await store.allProgress();
      const result: Record<
        string,
        { chapterIndex: number; progress: number; updatedAt: number }
      > = {};
      for (const record of records) {
        result[record.bookId] = {
          chapterIndex: record.chapterIndex,
          progress: record.progress,
          updatedAt: record.updatedAt,
        };
      }
      return result;
    },
    async loadProgress(bookId) {
      const record = await store.getProgress(bookId);
      return record
        ? { chapterIndex: record.chapterIndex, progress: record.progress }
        : null;
    },
    async saveProgress(bookId, chapterIndex, progress) {
      await store.putProgress({
        bookId,
        chapterIndex,
        progress: Math.min(1, Math.max(0, progress)),
        updatedAt: Date.now(),
      });
    },

    resolveBookLink(bookId, href): Promise<LinkTarget> {
      return serialized(async () => {
        const entry = currentBook(bookId);
        const draft: BookRenderRecord = {
          ...entry.render,
          links: { ...entry.render.links },
        };
        const linkCount = Object.keys(draft.links).length;
        const link = await (await epub()).resolvePublicationLink(
          entry.book,
          entry.file,
          draft,
          href
        );
        if (Object.keys(draft.links).length !== linkCount) {
          await store.putRender(draft);
          entry.render = draft;
        }
        if (link.kind === "internal") {
          return link;
        }
        const requestId = crypto.randomUUID();
        externalRequests.set(requestId, {
          url: link.url,
          origin: link.trustOrigin,
          expiresAt: Date.now() + EXTERNAL_REQUEST_TTL,
        });
        return {
          kind: "external",
          requestId,
          url: link.url,
          origin: link.trustOrigin,
          trusted: link.trustOrigin
            ? await store.isOriginTrusted(link.trustOrigin)
            : false,
        };
      });
    },
    async openExternalLink(requestId, mode: ExternalOpenMode) {
      const request = takeExternalRequest(requestId);
      if (
        mode === "trusted" &&
        !(request.origin && (await store.isOriginTrusted(request.origin)))
      ) {
        throw new Error("This site is not trusted.");
      }
      // Open before any further awaits so the browser still sees the click
      // as the user activation that permits a new window. With `noopener`
      // the call always returns null, so a blocked pop-up cannot be told
      // apart from a successful one here; the browser shows its own notice.
      window.open(request.url, "_blank", "noopener,noreferrer");
      if (mode === "trust" && request.origin) {
        await store.trustOrigin(request.origin);
      }
    },
    listTrustedSites: () => trustedSites(store),
    revokeTrustedSite: (origin) => store.revokeOrigin(origin),
    revokeAllTrustedSites: () => store.revokeAllOrigins(),

    listModels: (provider: ProviderConfig) => providerModels(provider),
    streamChat: (request: ChatRequest, receive, signal) =>
      providerChat(request, receive, signal),
    loadProviderConfig: async () =>
      (await store.getSetting("provider")) ?? null,
    saveProviderConfig: (config) =>
      config
        ? store.putSetting("provider", config)
        : store.deleteSetting("provider"),
  };
}

async function trustedSites(store: LeafletStore): Promise<TrustedSite[]> {
  const origins = await store.listTrustedOrigins();
  return origins.map(({ origin, trustedAt }) => ({ origin, trustedAt }));
}

/**
 * A file picker that works everywhere, including mobile Safari, by driving a
 * transient `<input type="file">`. Resolves `null` when the user cancels.
 */
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    let settled = false;
    const finish = (file: File | null) => {
      if (settled) {
        return;
      }
      settled = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => finish(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => finish(null));
    document.body.append(input);
    input.click();
  });
}
