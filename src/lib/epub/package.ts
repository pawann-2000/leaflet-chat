/**
 * OPF package model: metadata, manifest with fallback chains, spine, table of
 * contents (EPUB 3 nav document or EPUB 2 NCX), cover, and the
 * `META-INF/encryption.xml` resource transforms. Mirrors what the Rust crate
 * pulls out of `rbook`, expressed over a tiny `EntryReader` so the same code
 * serves the in-memory import and the stored-blob re-render paths.
 */
import type {
  NavigationTarget,
  ResourceEntry,
  ResourceTransform,
} from "@/lib/db/types";
import { EpubError } from "./errors";
import { IDPF_FONT_OBFUSCATION, idpfFontKey } from "./idpf";
import { encodeArchivePath } from "./urls";
import { decodeText } from "./zip";

/** Reads archive entries by absolute archive path (`/EPUB/text/ch1.xhtml`). */
export interface EntryReader {
  has(path: string): boolean;
  read(path: string): Promise<Uint8Array>;
  /** Index into the stored entry list, when the path exists. */
  zipIndex(path: string): number | undefined;
}

export interface ManifestItem {
  fallback: string | null;
  id: string;
  mediaType: string;
  /** Absolute, percent-decoded archive path. */
  path: string;
  properties: string[];
}

export interface SpineItem {
  idref: string;
  linear: boolean;
}

export interface EpubPackage {
  authors: string[];
  coverPath: string | null;
  identifier: string | null;
  language: string | null;
  manifest: Map<string, ManifestItem>;
  navPath: string | null;
  ncxPath: string | null;
  opfPath: string;
  pageDirection: "default" | "left-to-right" | "right-to-left";
  spine: SpineItem[];
  title: string;
}

export interface ChapterPlan {
  /** Spine idref; becomes the chapter summary id. */
  id: string;
  index: number;
  /** Original entry path followed by fallback paths up to the readable one. */
  linkPaths: string[];
  /** Absolute path of the readable document. */
  path: string;
  title: string;
}

const CONTAINER_PATH = "/META-INF/container.xml";
const ENCRYPTION_PATH = "/META-INF/encryption.xml";

// ---------------------------------------------------------------------------
// XML helpers

function localName(element: Element): string {
  const name = element.localName || element.nodeName;
  const colon = name.lastIndexOf(":");
  return (colon >= 0 ? name.slice(colon + 1) : name).toLowerCase();
}

function hasParserError(doc: Document): boolean {
  return (
    !doc.documentElement || doc.getElementsByTagName("parsererror").length > 0
  );
}

function tryParseXml(parser: DOMParser, text: string): Document | null {
  try {
    const doc = parser.parseFromString(text, "application/xml");
    return hasParserError(doc) ? null : doc;
  } catch {
    return null;
  }
}

const XML_ENTITIES = new Set(["amp", "lt", "gt", "quot", "apos"]);
const PROLOG_AND_COMMENTS = /<\?[^?]*\?>|<!--[\s\S]*?-->/gu;
const XMLNS_DECLARATION = /xmlns:([\w.-]+)=/gu;
const WHITESPACE = /\s+/gu;
const LEADING_HASH = /^#/u;
const TITLE_SEPARATORS = /[-_]/gu;
const NAMED_ENTITY = /&([a-zA-Z][a-zA-Z0-9]*);/gu;
const PREFIXED_NAME = /(?:<|\s)([a-zA-Z_][\w.-]*):[a-zA-Z_]/gu;
const ROOT_START_TAG = /<([a-zA-Z_][\w.-]*)(\s[^>]*)?>/u;
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/iu;
const KNOWN_NAMESPACES: Record<string, string> = {
  dc: "http://purl.org/dc/elements/1.1/",
  dcterms: "http://purl.org/dc/terms/",
  epub: "http://www.idpf.org/2007/ops",
  opf: "http://www.idpf.org/2007/opf",
  xlink: "http://www.w3.org/1999/xlink",
};

function decodeNamedEntity(name: string): string | null {
  const probe = document.createElement("textarea");
  probe.innerHTML = `&${name};`;
  const value = probe.value;
  return value === `&${name};` ? null : value;
}

/**
 * Publications in the wild often ship package documents that are not
 * well-formed XML in two specific ways: HTML named entities (`&nbsp;`) and
 * attribute prefixes (`opf:role`) without a namespace declaration. Repair those
 * so the strict parser can be used; anything else still falls back to HTML.
 */
export function repairXml(text: string): string {
  let repaired = text.replace(NAMED_ENTITY, (match, name: string) => {
    if (XML_ENTITIES.has(name)) {
      return match;
    }
    const decoded = decodeNamedEntity(name);
    return decoded === null
      ? `&amp;${name};`
      : [...decoded].map((char) => `&#${char.codePointAt(0)};`).join("");
  });
  const root = ROOT_START_TAG.exec(repaired.replace(PROLOG_AND_COMMENTS, ""));
  if (!root) {
    return repaired;
  }
  const declared = new Set(
    [...repaired.matchAll(XMLNS_DECLARATION)].map((match) => match[1])
  );
  const missing = new Set<string>();
  for (const match of repaired.matchAll(PREFIXED_NAME)) {
    const prefix = match[1];
    if (prefix !== "xml" && prefix !== "xmlns" && !declared.has(prefix)) {
      missing.add(prefix);
    }
  }
  if (missing.size === 0) {
    return repaired;
  }
  const declarations = [...missing]
    .map(
      (prefix) =>
        ` xmlns:${prefix}="${KNOWN_NAMESPACES[prefix] ?? `urn:leaflet:undeclared:${prefix}`}"`
    )
    .join("");
  const start = repaired.indexOf(root[0]);
  repaired = `${repaired.slice(0, start)}<${root[1]}${declarations}${root[2] ?? ""}>${repaired.slice(start + root[0].length)}`;
  return repaired;
}

export function parseXml(text: string): Document {
  const parser = new DOMParser();
  return (
    tryParseXml(parser, text) ??
    tryParseXml(parser, repairXml(text)) ??
    parser.parseFromString(text, "text/html")
  );
}

/**
 * Text of a `<meta>` element. In the HTML fallback parse `meta` is void, so
 * its content lands in the following text node.
 */
function metaText(meta: Element): string {
  const own = meta.textContent?.trim();
  if (own) {
    return own;
  }
  const next = meta.nextSibling;
  return next?.nodeType === Node.TEXT_NODE ? (next.nodeValue ?? "").trim() : "";
}

export function descendants(root: ParentNode, name: string): Element[] {
  const found: Element[] = [];
  for (const element of root.querySelectorAll("*")) {
    if (localName(element) === name) {
      found.push(element);
    }
  }
  return found;
}

function firstText(root: ParentNode, name: string): string | null {
  for (const element of descendants(root, name)) {
    const value = element.textContent?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

export function collapseWhitespace(text: string): string {
  return text.replace(WHITESPACE, " ").trim();
}

// ---------------------------------------------------------------------------
// Paths

/** Resolve an href relative to an absolute archive path; drops query and fragment. */
export function resolveArchivePath(base: string, href: string): string {
  const baseUrl = `file://${encodeArchivePath(base)}`;
  let resolved: URL;
  try {
    resolved = new URL(href.trim(), baseUrl);
  } catch {
    return base;
  }
  return decodePath(resolved.pathname);
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function directoryOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/") + 1);
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

// ---------------------------------------------------------------------------
// Media types

export function isDocumentType(mediaType: string): boolean {
  const lower = mediaType.toLowerCase();
  return (
    lower === "application/xhtml+xml" ||
    lower === "image/svg+xml" ||
    lower === "text/html"
  );
}

export function isImageType(mediaType: string): boolean {
  switch (mediaType.toLowerCase()) {
    case "image/avif":
    case "image/bmp":
    case "image/gif":
    case "image/jpeg":
    case "image/png":
    case "image/svg+xml":
    case "image/webp":
      return true;
    default:
      return false;
  }
}

export function isFontType(
  mediaType: string,
  extension: string | null
): boolean {
  const lower = mediaType.toLowerCase();
  if (lower.startsWith("font/")) {
    return true;
  }
  switch (lower) {
    case "application/font-sfnt":
    case "application/font-woff":
    case "application/vnd.ms-fontobject":
    case "application/vnd.ms-opentype":
    case "application/x-font-opentype":
    case "application/x-font-truetype":
      return true;
    case "application/octet-stream":
      return (
        extension !== null &&
        ["eot", "otf", "ttf", "woff", "woff2"].includes(extension.toLowerCase())
      );
    default:
      return false;
  }
}

export function isRenderableType(
  mediaType: string,
  extension: string | null
): boolean {
  const lower = mediaType.toLowerCase();
  return (
    lower === "text/css" ||
    isImageType(lower) ||
    isFontType(lower, extension) ||
    lower.startsWith("audio/") ||
    lower.startsWith("video/")
  );
}

export function pathExtension(path: string): string | null {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : null;
}

// ---------------------------------------------------------------------------
// Package parsing

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: flat OPF walk; splitting it would hide the spec order.
export async function parsePackage(reader: EntryReader): Promise<EpubPackage> {
  if (!reader.has(CONTAINER_PATH)) {
    throw new EpubError("parse", "missing META-INF/container.xml");
  }
  const container = parseXml(decodeText(await reader.read(CONTAINER_PATH)));
  // Prefer the rootfile declared as a package document; fall back to the
  // first declared path that exists, so a decoy or stale entry does not block
  // an otherwise valid publication.
  const rootfiles = descendants(container, "rootfile")
    .map((element) => ({
      mediaType: element.getAttribute("media-type")?.trim().toLowerCase() ?? "",
      path: element.getAttribute("full-path")?.trim() ?? "",
    }))
    .filter((rootfile) => rootfile.path)
    .map((rootfile) => ({
      ...rootfile,
      path: resolveArchivePath("/", rootfile.path),
    }));
  if (rootfiles.length === 0) {
    throw new EpubError("parse", "container.xml declares no rootfile");
  }
  const opfPath = (
    rootfiles.find(
      (rootfile) =>
        rootfile.mediaType === "application/oebps-package+xml" &&
        reader.has(rootfile.path)
    ) ??
    rootfiles.find((rootfile) => reader.has(rootfile.path)) ??
    rootfiles[0]
  ).path;
  if (!reader.has(opfPath)) {
    throw new EpubError("parse", `missing package document ${opfPath}`);
  }
  const opf = parseXml(decodeText(await reader.read(opfPath)));
  // When the OPF is not well-formed XML (undeclared prefixes, HTML entities)
  // the lenient HTML parse wraps it in <html><body>, so look for the element.
  const pkg =
    opf.documentElement && localName(opf.documentElement) === "package"
      ? opf.documentElement
      : descendants(opf, "package")[0];
  if (!pkg) {
    throw new EpubError("parse", "the package document has no <package> root");
  }

  const manifest = new Map<string, ManifestItem>();
  const manifestElement = descendants(pkg, "manifest")[0];
  for (const item of manifestElement
    ? descendants(manifestElement, "item")
    : []) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (!(id && href)) {
      continue;
    }
    manifest.set(id, {
      id,
      path: resolveArchivePath(opfPath, href),
      mediaType: (item.getAttribute("media-type") ?? "").trim(),
      properties: (item.getAttribute("properties") ?? "")
        .split(WHITESPACE)
        .filter(Boolean),
      fallback: item.getAttribute("fallback")?.trim() || null,
    });
  }

  const spineElement = descendants(pkg, "spine")[0];
  const spine: SpineItem[] = [];
  for (const itemref of spineElement
    ? descendants(spineElement, "itemref")
    : []) {
    const idref = itemref.getAttribute("idref");
    if (idref) {
      spine.push({
        idref,
        linear: itemref.getAttribute("linear")?.trim().toLowerCase() !== "no",
      });
    }
  }
  const direction = spineElement
    ?.getAttribute("page-progression-direction")
    ?.trim()
    .toLowerCase();
  let pageDirection: EpubPackage["pageDirection"] = "default";
  if (direction === "ltr") {
    pageDirection = "left-to-right";
  } else if (direction === "rtl") {
    pageDirection = "right-to-left";
  }

  const metadata = descendants(pkg, "metadata")[0] ?? pkg;
  const uniqueId = pkg.getAttribute("unique-identifier");
  const identifiers = descendants(metadata, "identifier");
  const identifier =
    (uniqueId &&
      identifiers.find((element) => element.getAttribute("id") === uniqueId)) ||
    identifiers[0];

  let coverPath: string | null = null;
  const coverItem =
    [...manifest.values()].find((item) =>
      item.properties.includes("cover-image")
    ) ?? coverFromMeta(metadata, manifest);
  if (coverItem) {
    const image = fallbackChain(manifest, coverItem).find((item) =>
      isImageType(item.mediaType)
    );
    coverPath = image?.path ?? null;
  }

  const navItem = [...manifest.values()].find((item) =>
    item.properties.includes("nav")
  );
  const tocId = spineElement?.getAttribute("toc")?.trim();
  const ncxItem = tocId ? manifest.get(tocId) : undefined;

  return {
    authors: descendants(metadata, "creator")
      .map((element) => collapseWhitespace(element.textContent ?? ""))
      .filter(Boolean),
    coverPath,
    identifier: identifier?.textContent?.trim() || null,
    language: firstText(metadata, "language"),
    manifest,
    navPath: navItem?.path ?? null,
    ncxPath: ncxItem?.path ?? null,
    opfPath,
    pageDirection,
    spine,
    title: mainTitle(metadata) ?? "Untitled publication",
  };
}

/**
 * EPUB 3 can refine one `dc:title` as the main title
 * (`<meta refines="#id" property="title-type">main</meta>`); prefer it, else
 * the first non-empty title, matching rbook.
 */
function mainTitle(metadata: Element): string | null {
  const titles = descendants(metadata, "title");
  for (const meta of descendants(metadata, "meta")) {
    if (meta.getAttribute("property")?.trim() !== "title-type") {
      continue;
    }
    if (metaText(meta).toLowerCase() !== "main") {
      continue;
    }
    const refines = meta
      .getAttribute("refines")
      ?.trim()
      .replace(LEADING_HASH, "");
    const title =
      refines &&
      titles.find((element) => element.getAttribute("id") === refines);
    const value = title && collapseWhitespace(title.textContent ?? "");
    if (value) {
      return value;
    }
  }
  return firstText(metadata, "title");
}

function coverFromMeta(
  metadata: Element,
  manifest: Map<string, ManifestItem>
): ManifestItem | undefined {
  for (const meta of descendants(metadata, "meta")) {
    if (meta.getAttribute("name")?.trim().toLowerCase() !== "cover") {
      continue;
    }
    const content = meta.getAttribute("content")?.trim();
    if (!content) {
      continue;
    }
    const byId = manifest.get(content);
    if (byId) {
      return byId;
    }
    const byPath = [...manifest.values()].find(
      (item) => fileName(item.path) === fileName(content)
    );
    if (byPath) {
      return byPath;
    }
  }
  return undefined;
}

/** The item followed by its fallbacks, cycle-safe. */
export function fallbackChain(
  manifest: Map<string, ManifestItem>,
  item: ManifestItem
): ManifestItem[] {
  const chain: ManifestItem[] = [];
  const seen = new Set<string>();
  let current: ManifestItem | undefined = item;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = current.fallback ? manifest.get(current.fallback) : undefined;
  }
  return chain;
}

export function readableEntry(
  manifest: Map<string, ManifestItem>,
  item: ManifestItem
): ManifestItem | undefined {
  return fallbackChain(manifest, item).find((candidate) =>
    isDocumentType(candidate.mediaType)
  );
}

export function renderableEntry(
  manifest: Map<string, ManifestItem>,
  item: ManifestItem
): ManifestItem | undefined {
  return fallbackChain(manifest, item).find((candidate) =>
    isRenderableType(candidate.mediaType, pathExtension(candidate.path))
  );
}

export function resourceTitle(path: string, index: number): string {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const title = stem.replace(TITLE_SEPARATORS, " ").trim();
  return title || `Section ${index + 1}`;
}

// ---------------------------------------------------------------------------
// Table of contents

export interface TocSourceEntry {
  depth: number;
  fragment: string | null;
  /** Absolute archive path without the fragment. */
  path: string;
  title: string;
}

function directChildren(root: Element, name: string): Element[] {
  return [...root.children].filter((child) => localName(child) === name);
}

function tocDestination(
  base: string,
  href: string
): Pick<TocSourceEntry, "path" | "fragment"> | null {
  const trimmed = href.trim();
  if (URI_SCHEME.test(trimmed) || trimmed.startsWith("//")) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed, `file://${encodeArchivePath(base)}`);
  } catch {
    return null;
  }
  // TOC entries are archive-local documents. Reject schemes, network-path
  // references, queries, and malformed fragments before creating UI links.
  if (url.protocol !== "file:" || url.host || url.search) {
    return null;
  }
  let fragment: string | null = null;
  if (url.hash.length > 1) {
    try {
      fragment = decodeURIComponent(url.hash.slice(1));
    } catch {
      return null;
    }
    if (
      [...fragment].some((char) => {
        const code = char.codePointAt(0) ?? 0;
        return code < 32 || code === 127;
      })
    ) {
      return null;
    }
  }
  return { path: decodePath(url.pathname), fragment };
}

function epub3Toc(doc: Document, base: string): TocSourceEntry[] {
  const nav = descendants(doc, "nav").find((element) =>
    (
      element.getAttribute("epub:type") ??
      element.getAttributeNS("http://www.idpf.org/2007/ops", "type") ??
      ""
    )
      .split(WHITESPACE)
      .includes("toc")
  );
  if (!nav) {
    return [];
  }
  const entries: TocSourceEntry[] = [];
  const walk = (list: Element, depth: number) => {
    for (const li of directChildren(list, "li")) {
      for (const child of li.children) {
        if (localName(child) === "a") {
          const href = child.getAttribute("href");
          const destination = href && tocDestination(base, href);
          if (destination) {
            entries.push({
              ...destination,
              depth,
              title: collapseWhitespace(child.textContent ?? ""),
            });
          }
        } else if (localName(child) === "ol") {
          walk(child, depth + 1);
        }
      }
    }
  };
  for (const list of directChildren(nav, "ol")) {
    walk(list, 0);
  }
  return entries;
}

function epub2Toc(doc: Document, base: string): TocSourceEntry[] {
  const navMap = descendants(doc, "navmap")[0];
  if (!navMap) {
    return [];
  }
  const entries: TocSourceEntry[] = [];
  const walk = (parent: Element, depth: number) => {
    for (const point of directChildren(parent, "navpoint")) {
      const label = directChildren(point, "navlabel")[0];
      const title = label
        ? collapseWhitespace(descendants(label, "text")[0]?.textContent ?? "")
        : "";
      const href = directChildren(point, "content")[0]?.getAttribute("src");
      const destination = href && tocDestination(base, href);
      if (destination) {
        entries.push({ ...destination, depth, title });
      }
      walk(point, depth + 1);
    }
  };
  walk(navMap, 0);
  return entries;
}

/** Source-order TOC entries, keeping distinct fragments and nesting. */
export async function tocEntries(
  pkg: EpubPackage,
  reader: EntryReader
): Promise<TocSourceEntry[]> {
  const reachablePaths = new Set(
    [...pkg.manifest.values()]
      .filter((item) => {
        const readable = readableEntry(pkg.manifest, item);
        return readable && reader.has(readable.path);
      })
      .map((item) => item.path)
  );
  if (pkg.navPath && reader.has(pkg.navPath)) {
    const nav = parseXml(decodeText(await reader.read(pkg.navPath)));
    const entries = epub3Toc(nav, pkg.navPath).filter((entry) =>
      reachablePaths.has(entry.path)
    );
    if (entries.length > 0) {
      return entries;
    }
  }
  if (pkg.ncxPath && reader.has(pkg.ncxPath)) {
    const ncx = parseXml(decodeText(await reader.read(pkg.ncxPath)));
    return epub2Toc(ncx, pkg.ncxPath).filter((entry) =>
      reachablePaths.has(entry.path)
    );
  }
  return [];
}

/** Absolute document path (no fragment) -> first non-empty TOC label. */
export function tocTitles(entries: TocSourceEntry[]): Map<string, string> {
  const titles = new Map<string, string>();
  for (const entry of entries) {
    if (entry.title && !titles.has(entry.path)) {
      titles.set(entry.path, entry.title);
    }
  }
  return titles;
}

// ---------------------------------------------------------------------------
// Reading order

export function planChapters(
  pkg: EpubPackage,
  titles: Map<string, string>
): ChapterPlan[] {
  const resolve = (items: SpineItem[]) =>
    items.flatMap((entry) => {
      const original = pkg.manifest.get(entry.idref);
      if (!original) {
        return [];
      }
      const readable = readableEntry(pkg.manifest, original);
      return readable ? [{ entry, original, readable }] : [];
    });

  let entries = resolve(pkg.spine.filter((entry) => entry.linear));
  if (entries.length === 0) {
    entries = resolve(pkg.spine);
  }

  return entries.map(({ entry, original, readable }, index) => {
    const linkPaths: string[] = [];
    for (const item of fallbackChain(pkg.manifest, original)) {
      linkPaths.push(item.path);
      if (item.id === readable.id) {
        break;
      }
    }
    return {
      id: entry.idref,
      index,
      linkPaths,
      path: readable.path,
      title:
        titles.get(readable.path) ??
        linkPaths.map((path) => titles.get(path)).find(Boolean) ??
        resourceTitle(readable.path, index),
    };
  });
}

export function navigationTargets(
  pkg: EpubPackage,
  titles: Map<string, string>,
  chapters: ChapterPlan[]
): Record<string, NavigationTarget> {
  const targets: Record<string, NavigationTarget> = {};
  for (const chapter of chapters) {
    const target: NavigationTarget = {
      chapterIndex: chapter.index,
      id: chapter.id,
      path: chapter.path,
      title: chapter.title,
    };
    for (const path of chapter.linkPaths) {
      targets[path] = target;
    }
  }
  for (const original of pkg.manifest.values()) {
    const readable = readableEntry(pkg.manifest, original);
    if (!readable || original.path in targets) {
      continue;
    }
    targets[original.path] = {
      chapterIndex: null,
      id: readable.id,
      path: readable.path,
      title:
        titles.get(readable.path) ??
        titles.get(original.path) ??
        resourceTitle(readable.path, Object.keys(targets).length),
    };
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Resources

export interface ResourceTransforms {
  fontKey: Uint8Array | null;
  /** Manifest id -> transform. */
  transforms: Map<string, ResourceTransform>;
}

export async function resourceTransforms(
  pkg: EpubPackage,
  reader: EntryReader
): Promise<ResourceTransforms> {
  const fontKey = pkg.identifier ? await idpfFontKey(pkg.identifier) : null;
  const transforms = new Map<string, ResourceTransform>();
  if (!reader.has(ENCRYPTION_PATH)) {
    return { fontKey, transforms };
  }
  let doc: Document;
  try {
    doc = parseXml(decodeText(await reader.read(ENCRYPTION_PATH)));
  } catch {
    return { fontKey, transforms };
  }
  const byPath = new Map(
    [...pkg.manifest.values()].map((item) => [item.path, item])
  );
  for (const encrypted of descendants(doc, "encrypteddata")) {
    const algorithm = descendants(
      encrypted,
      "encryptionmethod"
    )[0]?.getAttribute("Algorithm");
    const uri = descendants(encrypted, "cipherreference")[0]?.getAttribute(
      "URI"
    );
    if (!(algorithm && uri)) {
      continue;
    }
    const entry = byPath.get(resolveArchivePath("/", uri));
    if (!entry) {
      continue;
    }
    const obfuscatedFont =
      algorithm === IDPF_FONT_OBFUSCATION &&
      isFontType(entry.mediaType, pathExtension(entry.path));
    transforms.set(
      entry.id,
      obfuscatedFont && fontKey ? "idpf-font" : "unsupported"
    );
  }
  return { fontKey, transforms };
}

/** Manifest-declared render resources keyed by the original entry's path. */
export function resourceMap(
  pkg: EpubPackage,
  transforms: Map<string, ResourceTransform>,
  reader: EntryReader
): Record<string, ResourceEntry> {
  const resources: Record<string, ResourceEntry> = {};
  for (const original of pkg.manifest.values()) {
    const renderable = renderableEntry(pkg.manifest, original);
    if (!renderable) {
      continue;
    }
    const zipIndex = reader.zipIndex(renderable.path);
    if (zipIndex === undefined) {
      continue;
    }
    resources[original.path] = {
      mediaType: renderable.mediaType.toLowerCase(),
      transform: transforms.get(renderable.id) ?? "none",
      zipIndex,
    };
  }
  return resources;
}

export { directoryOf };
