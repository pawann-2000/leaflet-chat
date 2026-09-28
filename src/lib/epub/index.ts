// biome-ignore-all lint/performance/noBarrelFile: single public entry point of the EPUB engine.
/**
 * Browser EPUB engine — the web counterpart of the `reader-epub` crate.
 *
 *   importEpub()             file -> records for IndexedDB (preflight, parse, render)
 *   renderStoredBook()       rebuild the render record from a stored file
 *   openedPublication()      records -> the UI's OpenedPublication
 *   resolvePublicationLink() opaque anchor token -> internal/external target
 */
import {
  type BookFileRecord,
  type BookRecord,
  type BookRenderRecord,
  RENDER_VERSION,
} from "@/lib/db/types";
import type {
  Chapter,
  OpenedPublication,
  PublicationDocument,
  TocEntry,
} from "@/lib/types";
import { EpubError } from "./errors";
import {
  type ChapterPlan,
  type EntryReader,
  type EpubPackage,
  navigationTargets,
  parsePackage,
  planChapters,
  resourceMap,
  resourceTransforms,
  type TocSourceEntry,
  tocEntries,
  tocTitles,
} from "./package";
import {
  createRenderContext,
  type RenderContext,
  registerLink,
  renderDocument,
} from "./render";
import { inspectEpub } from "./security";
import { bookResourceUrl, parseBookResourceUrl } from "./urls";
import { decodeText, readEntry, readEntryFromBlob, type ZipEntry } from "./zip";

export { EpubError, type EpubErrorCode } from "./errors";
export { EXTERNAL_LINK_PREFIX, INTERNAL_LINK_PREFIX } from "./render";

export interface ImportedBook {
  book: BookRecord;
  file: BookFileRecord;
  render: BookRenderRecord;
}

export type PublicationLink =
  | {
      kind: "internal";
      chapter: Chapter;
      chapterIndex: number | null;
      fragment: string | null;
    }
  | { kind: "external"; url: string; trustOrigin: string | null };

const TOKEN =
  /^#leaflet-link-(?:internal|external)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function commitRegisteredLinks(
  render: BookRenderRecord,
  context: RenderContext
): void {
  for (const [token, destination] of Object.entries(context.links)) {
    if (TOKEN.test(token) && !Object.hasOwn(render.links, token)) {
      render.links[token] = destination;
    }
  }
}

// ---------------------------------------------------------------------------
// Entry readers

function entryIndex(entries: ZipEntry[]): Map<string, number> {
  const index = new Map<string, number>();
  entries.forEach((entry, position) => {
    if (!index.has(`/${entry.name}`)) {
      index.set(`/${entry.name}`, position);
    }
  });
  return index;
}

function memoryReader(archive: Uint8Array, entries: ZipEntry[]): EntryReader {
  const index = entryIndex(entries);
  return {
    has: (path) => index.has(path),
    zipIndex: (path) => index.get(path),
    read: (path) => {
      const position = index.get(path);
      if (position === undefined) {
        return Promise.reject(
          new EpubError("parse", `missing archive entry ${path}`)
        );
      }
      try {
        return Promise.resolve(readEntry(archive, entries[position]));
      } catch (error) {
        return Promise.reject(
          new EpubError(
            "parse",
            error instanceof Error ? error.message : String(error)
          )
        );
      }
    },
  };
}

function blobReader(blob: Blob, entries: ZipEntry[]): EntryReader {
  const index = entryIndex(entries);
  return {
    has: (path) => index.has(path),
    zipIndex: (path) => index.get(path),
    read: async (path) => {
      const position = index.get(path);
      if (position === undefined) {
        throw new EpubError("parse", `missing archive entry ${path}`);
      }
      try {
        return await readEntryFromBlob(blob, entries[position]);
      } catch (error) {
        throw new EpubError(
          "parse",
          error instanceof Error ? error.message : String(error)
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Pipeline

interface Plan {
  chapters: ChapterPlan[];
  documentPaths: string[];
  pkg: EpubPackage;
  sourceNavigation: TocSourceEntry[];
  targets: BookRenderRecord["navigationTargets"];
}

async function plan(reader: EntryReader): Promise<Plan> {
  const pkg = await parsePackage(reader);
  const sourceNavigation = await tocEntries(pkg, reader);
  const titles = tocTitles(sourceNavigation);
  const chapters = planChapters(pkg, titles);
  if (chapters.length === 0) {
    throw new EpubError("no_readable_content");
  }
  if (chapters.some((chapter) => !reader.has(chapter.path))) {
    throw new EpubError(
      "parse",
      "the reading order references a missing document"
    );
  }
  const targets = navigationTargets(pkg, titles, chapters);
  const documentPaths: string[] = [];
  const included = new Set<string>();
  for (const item of pkg.manifest.values()) {
    const target = targets[item.path];
    if (target && reader.has(target.path) && !included.has(target.id)) {
      included.add(target.id);
      documentPaths.push(item.path);
    }
  }
  return {
    chapters,
    documentPaths,
    pkg,
    sourceNavigation,
    targets,
  };
}

function internalToken(
  bookId: string,
  path: string,
  fragment: string | null,
  context: RenderContext
): string | null {
  const destination = new URL(bookResourceUrl(bookId, path));
  if (fragment !== null) {
    destination.hash = fragment;
  }
  return registerLink(destination.href, {
    baseUrl: destination.href,
    context,
  });
}

function renderDocuments(
  bookId: string,
  plan: Plan,
  context: RenderContext
): PublicationDocument[] {
  const documents: PublicationDocument[] = [];
  for (const path of plan.documentPaths) {
    const target = plan.targets[path];
    const link = internalToken(bookId, path, null, context);
    if (!(target && link)) {
      throw new EpubError("parse", "a publication document is unreachable");
    }
    documents.push({
      chapterIndex: target.chapterIndex,
      id: target.id,
      link,
      title: target.title,
    });
  }
  return documents;
}

function renderNavigation(
  bookId: string,
  plan: Plan,
  context: RenderContext
): TocEntry[] {
  const navigation: TocEntry[] = [];
  const add = (
    id: string,
    path: string,
    fragment: string | null,
    depth: number,
    title: string
  ) => {
    const target = plan.targets[path];
    if (!target) {
      throw new EpubError("parse", "a table of contents target is unreachable");
    }
    const link = internalToken(bookId, path, fragment, context);
    if (!link) {
      throw new EpubError("parse", "a table of contents link is invalid");
    }
    navigation.push({
      chapterId: target.id,
      chapterIndex: target.chapterIndex,
      depth,
      fragment,
      id,
      link,
      title: title || target.title,
    });
  };

  for (const source of plan.sourceNavigation) {
    add(
      `toc-${navigation.length}`,
      source.path,
      source.fragment,
      source.depth,
      source.title
    );
  }
  // A publication without a usable TOC still exposes every spine document.
  if (navigation.length === 0) {
    for (const chapter of plan.chapters) {
      add(`spine-${chapter.index}`, chapter.path, null, 0, chapter.title);
    }
  }
  if (navigation.length === 0) {
    throw new EpubError("parse", "the publication has no reachable navigation");
  }
  return navigation;
}

function prepareRender(
  bookId: string,
  plan: Plan,
  links: Record<string, string> = {}
): BookRenderRecord {
  const context = createRenderContext(bookId, links);
  const navigation = renderNavigation(bookId, plan, context);
  const documents = renderDocuments(bookId, plan, context);
  return {
    chapters: [],
    documents,
    id: bookId,
    links: context.links,
    navigation,
    navigationTargets: plan.targets,
    renderVersion: RENDER_VERSION,
    spinePaths: plan.chapters.map((chapter) => chapter.path),
    summaries: plan.chapters.map(({ id, index, title }) => ({
      id,
      index,
      title,
    })),
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function blobBytes(source: Blob): Promise<Uint8Array> {
  return new Uint8Array(await source.arrayBuffer());
}

/** Validate, hash, parse and render an EPUB file into storable records. */
export async function importEpub(
  source: Blob,
  fileName: string
): Promise<ImportedBook> {
  const bytes = await blobBytes(source);
  const directory = inspectEpub(fileName, bytes);
  const id = await sha256Hex(bytes);
  const reader = memoryReader(bytes, directory.entries);
  const laid = await plan(reader);
  const { fontKey, transforms } = await resourceTransforms(laid.pkg, reader);
  const now = Date.now();

  const book: BookRecord = {
    addedAt: now,
    authors: laid.pkg.authors,
    chapterCount: laid.chapters.length,
    coverPath: laid.pkg.coverPath,
    deletedAt: null,
    fileName,
    id,
    language: laid.pkg.language,
    lastOpenedAt: now,
    pageDirection: laid.pkg.pageDirection,
    size: bytes.byteLength,
    title: laid.pkg.title,
    updatedAt: now,
  };
  const file: BookFileRecord = {
    blob: new Blob([bytes as BlobPart], { type: "application/epub+zip" }),
    entries: directory.entries,
    fontKey,
    id,
    resources: resourceMap(laid.pkg, transforms, reader),
  };
  const render = prepareRender(id, laid);
  return { book, file, render };
}

/** Rebuild the render record from a stored file (renderer upgrades, missing render). */
export async function renderStoredBook(
  book: BookRecord,
  file: BookFileRecord
): Promise<BookRenderRecord> {
  if (book.id !== file.id) {
    throw new EpubError("parse", "stored publication records do not match");
  }
  const reader = blobReader(file.blob, file.entries);
  return prepareRender(book.id, await plan(reader));
}

function matchingStoredRecords(
  book: BookRecord,
  file: BookFileRecord,
  render: BookRenderRecord
): boolean {
  return book.id === file.id && book.id === render.id;
}

/**
 * Render one linear spine document from stored bytes. The caller owns caching
 * the chapter and persisting `render.links`, which gains any links in its HTML.
 */
export async function renderStoredChapter(
  book: BookRecord,
  file: BookFileRecord,
  render: BookRenderRecord,
  index: number
): Promise<Chapter> {
  if (!matchingStoredRecords(book, file, render)) {
    throw new EpubError("parse", "stored publication records do not match");
  }
  const summary = render.summaries[index];
  if (!summary || summary.index !== index) {
    throw new EpubError("parse", "the requested chapter is unavailable");
  }
  const path = render.spinePaths[index];
  const target = path && render.navigationTargets[path];
  if (!target || target.chapterIndex !== index || target.id !== summary.id) {
    throw new EpubError(
      "parse",
      "the requested chapter has no source document"
    );
  }
  const reader = blobReader(file.blob, file.entries);
  const text = decodeText(await reader.read(path));
  const context = createRenderContext(book.id, { ...render.links });
  const chapter = renderDocument(
    context,
    text,
    path,
    summary.id,
    summary.title,
    index
  );
  commitRegisteredLinks(render, context);
  return chapter;
}

export function openedPublication(
  book: BookRecord,
  render: BookRenderRecord
): OpenedPublication {
  if (book.id !== render.id) {
    throw new EpubError("parse", "stored publication records do not match");
  }
  return {
    book: {
      chapters: render.summaries,
      documents: render.documents,
      navigation: render.navigation,
      summary: {
        authors: book.authors,
        chapterCount: book.chapterCount,
        coverDataUrl: book.coverPath
          ? bookResourceUrl(book.id, book.coverPath)
          : null,
        fingerprint: book.id,
        id: book.id,
        language: book.language,
        pageDirection: book.pageDirection,
        sourcePath: book.fileName,
        title: book.title,
      },
    },
    chapters: [],
  };
}

/**
 * Resolve an anchor token from rendered HTML. Documents that are reachable but
 * outside the reading order are rendered on demand; their anchors are added to
 * `render.links`, so persist the record afterwards if those links should stay
 * resolvable across reloads.
 */
export async function resolvePublicationLink(
  book: BookRecord,
  file: BookFileRecord,
  render: BookRenderRecord,
  token: string
): Promise<PublicationLink> {
  if (!matchingStoredRecords(book, file, render)) {
    throw new EpubError("invalid_link");
  }
  if (!TOKEN.test(token)) {
    throw new EpubError("invalid_link");
  }
  const href = render.links[token];
  if (!href) {
    throw new EpubError("invalid_link");
  }
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw new EpubError("invalid_link");
  }

  const resource = parseBookResourceUrl(href);
  if (resource) {
    if (resource.bookId !== book.id) {
      throw new EpubError("invalid_link");
    }
    const target = render.navigationTargets[resource.resourcePath];
    if (!target) {
      throw new EpubError("link_not_found");
    }
    const fragment = url.hash.length > 1 ? url.hash.slice(1) : null;
    const rendered =
      target.chapterIndex === null
        ? undefined
        : render.chapters[target.chapterIndex];
    if (rendered) {
      return {
        kind: "internal",
        chapter: rendered,
        chapterIndex: target.chapterIndex,
        fragment,
      };
    }
    const reader = blobReader(file.blob, file.entries);
    const context: RenderContext = createRenderContext(book.id, {
      ...render.links,
    });
    const text = decodeText(await reader.read(target.path));
    const chapter = renderDocument(
      context,
      text,
      target.path,
      target.id,
      target.title,
      target.chapterIndex ?? 0
    );
    commitRegisteredLinks(render, context);
    return {
      kind: "internal",
      chapter,
      chapterIndex: target.chapterIndex,
      fragment,
    };
  }

  switch (url.protocol) {
    case "http:":
    case "https:":
      if (url.username || url.password) {
        throw new EpubError("invalid_link");
      }
      return { kind: "external", url: url.href, trustOrigin: url.origin };
    case "mailto:":
      return { kind: "external", url: url.href, trustOrigin: null };
    default:
      throw new EpubError("unsupported_link");
  }
}
