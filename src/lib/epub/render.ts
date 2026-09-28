/**
 * Chapter rendering: parse one publication document, lift language,
 * direction, stylesheet references and inline styles out of it, then sanitize
 * the body with DOMPurify configured to the exact allowlists the Rust
 * `ammonia` builder uses. Anchors become opaque tokens so the rendered page
 * never carries a navigable destination; the token registry lives on the
 * render record and is resolved by `resolvePublicationLink`.
 */
import createDOMPurify, { type DOMPurify } from "dompurify";
import type { Chapter } from "@/lib/types";
import { bookResourcePrefix, bookResourceUrl } from "./urls";

export const INTERNAL_LINK_PREFIX = "#leaflet-link-internal-";
export const EXTERNAL_LINK_PREFIX = "#leaflet-link-external-";
const REGISTERED_TOKEN =
  /^#leaflet-link-(?:internal|external)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_LINK_LENGTH = 8192;

export interface RenderContext {
  bookId: string;
  /** Token -> resolved absolute URL. Mutated as documents are rendered. */
  links: Record<string, string>;
  prefix: string;
  /** Reuses a destination's token when an evicted chapter is rendered again. */
  reverseLinks: Map<string, string>;
}

export function createRenderContext(
  bookId: string,
  links: Record<string, string> = {}
): RenderContext {
  const reverseLinks = new Map<string, string>();
  for (const [token, destination] of Object.entries(links)) {
    if (REGISTERED_TOKEN.test(token)) {
      reverseLinks.set(destination, token);
    }
  }
  return { bookId, links, prefix: bookResourcePrefix(bookId), reverseLinks };
}

// ---------------------------------------------------------------------------
// Allowlists (verbatim from crates/reader-epub/src/content.rs, lowercased)

const TAGS = [
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "b",
  "bdi",
  "bdo",
  "blockquote",
  "br",
  "caption",
  "circle",
  "cite",
  "clippath",
  "code",
  "col",
  "colgroup",
  "dd",
  "defs",
  "del",
  "desc",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "ellipse",
  "em",
  "figcaption",
  "figure",
  "footer",
  "g",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "image",
  "img",
  "ins",
  "kbd",
  "li",
  "line",
  "lineargradient",
  "main",
  "mark",
  "math",
  "mfrac",
  "mi",
  "mn",
  "mo",
  "mover",
  "mpadded",
  "mroot",
  "mrow",
  "ms",
  "mspace",
  "msqrt",
  "mstyle",
  "msub",
  "msubsup",
  "msup",
  "mtable",
  "mtd",
  "mtext",
  "mtr",
  "munder",
  "munderover",
  "nav",
  "ol",
  "p",
  "path",
  "pattern",
  "picture",
  "polygon",
  "polyline",
  "pre",
  "q",
  "rect",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "section",
  "small",
  "source",
  "span",
  "stop",
  "strong",
  "sub",
  "summary",
  "sup",
  "svg",
  "symbol",
  "table",
  "tbody",
  "td",
  "text",
  "tfoot",
  "th",
  "thead",
  "time",
  "title",
  "track",
  "tr",
  "tspan",
  "u",
  "ul",
  "use",
  "var",
  "wbr",
];

const TAG_ATTRIBUTES: Record<string, string[]> = {
  a: ["href", "name", "title"],
  blockquote: ["cite"],
  circle: ["cx", "cy", "pathlength", "r"],
  clippath: ["clippathunits"],
  col: ["span"],
  colgroup: ["span"],
  del: ["datetime"],
  ellipse: ["cx", "cy", "pathlength", "rx", "ry"],
  image: [
    "height",
    "href",
    "preserveaspectratio",
    "width",
    "x",
    "xlink:href",
    "y",
  ],
  img: ["alt", "height", "src", "title", "width"],
  ins: ["datetime"],
  line: ["pathlength", "x1", "x2", "y1", "y2"],
  lineargradient: [
    "gradienttransform",
    "gradientunits",
    "href",
    "spreadmethod",
    "x1",
    "x2",
    "xlink:href",
    "y1",
    "y2",
  ],
  math: ["display", "mathvariant", "xmlns"],
  ol: ["reversed", "start", "type"],
  path: ["d", "pathlength"],
  pattern: [
    "height",
    "href",
    "patterncontentunits",
    "patterntransform",
    "patternunits",
    "preserveaspectratio",
    "viewbox",
    "width",
    "x",
    "xlink:href",
    "y",
  ],
  polygon: ["pathlength", "points"],
  polyline: ["pathlength", "points"],
  q: ["cite"],
  rect: ["height", "pathlength", "rx", "ry", "width", "x", "y"],
  source: ["media", "src", "type"],
  stop: ["offset", "stop-color", "stop-opacity"],
  svg: [
    "height",
    "preserveaspectratio",
    "viewbox",
    "width",
    "x",
    "y",
    "xmlns",
    "xmlns:xlink",
  ],
  symbol: ["preserveaspectratio", "refx", "refy", "viewbox", "x", "y"],
  td: ["colspan", "headers", "rowspan"],
  text: ["dx", "dy", "lengthadjust", "rotate", "textlength", "x", "y"],
  th: ["colspan", "headers", "rowspan", "scope"],
  time: ["datetime"],
  track: ["default", "kind", "label", "src", "srclang"],
  tspan: ["dx", "dy", "lengthadjust", "rotate", "textlength", "x", "y"],
  use: ["height", "href", "width", "x", "xlink:href", "y"],
};

const GENERIC_ATTRIBUTES = [
  "aria-label",
  "class",
  "clip-path",
  "clip-rule",
  "color",
  "color-rendering",
  "dir",
  "display",
  "dominant-baseline",
  "epub:type",
  "fill",
  "fill-opacity",
  "fill-rule",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "id",
  "image-rendering",
  "lang",
  "marker-end",
  "marker-mid",
  "marker-start",
  "mask",
  "opacity",
  "overflow",
  "paint-order",
  "role",
  "shape-rendering",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "style",
  "text-anchor",
  "text-rendering",
  "title",
  "transform",
  "vector-effect",
  "visibility",
  "xml:lang",
];

/** Elements removed together with their content. */
const CLEAN_CONTENT_TAGS = [
  "applet",
  "audio",
  "canvas",
  "embed",
  "form",
  "iframe",
  "object",
  "script",
  "style",
  "template",
  "video",
  // Raw-text containers the HTML parser treats specially; keeping their text
  // would re-expose markup the sanitizer never saw as elements.
  "noscript",
  "noembed",
  "noframes",
  "plaintext",
  "xmp",
  "head",
];

const GENERIC = new Set(GENERIC_ATTRIBUTES);
const PER_TAG = new Map(
  Object.entries(TAG_ATTRIBUTES).map(([tag, attributes]) => [
    tag,
    new Set(attributes),
  ])
);
const ALL_ATTRIBUTES = [
  ...new Set([...GENERIC_ATTRIBUTES, ...Object.values(TAG_ATTRIBUTES).flat()]),
];
const URL_ATTRIBUTES = new Set(["href", "src", "xlink:href"]);
const UNSAFE_STYLE =
  /url\s*\(|expression\s*\(|@import|behavior\s*:|-moz-binding/iu;
const WHITESPACE = /\s+/gu;
const ALLOWED_URI =
  /^(?:(?:https?|mailto|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/iu;

// ---------------------------------------------------------------------------
// Sanitizer

interface SanitizeState {
  baseUrl: string;
  context: RenderContext;
}

let purifier: DOMPurify | null = null;
let active: SanitizeState | null = null;

function isBookUrl(url: URL, context: RenderContext): boolean {
  return url.href.startsWith(context.prefix);
}

/** Port of `LinkRegistry::register`: returns a token or `null` to drop the link. */
export function registerLink(
  href: string,
  state: SanitizeState
): string | null {
  if (href.length > MAX_LINK_LENGTH) {
    return null;
  }
  let resolved: URL;
  try {
    resolved = new URL(href, state.baseUrl);
  } catch {
    return null;
  }
  let prefix: string;
  if (isBookUrl(resolved, state.context)) {
    prefix = INTERNAL_LINK_PREFIX;
  } else if (
    (resolved.protocol === "http:" || resolved.protocol === "https:") &&
    resolved.hostname &&
    !resolved.username &&
    !resolved.password
  ) {
    prefix = EXTERNAL_LINK_PREFIX;
  } else if (resolved.protocol === "mailto:" && resolved.pathname) {
    prefix = EXTERNAL_LINK_PREFIX;
  } else {
    return null;
  }
  const existing = state.context.reverseLinks.get(resolved.href);
  if (existing?.startsWith(prefix)) {
    return existing;
  }
  const token = `${prefix}${crypto.randomUUID()}`;
  state.context.links[token] = resolved.href;
  state.context.reverseLinks.set(resolved.href, token);
  return token;
}

function resolveResourceUrl(
  value: string,
  state: SanitizeState
): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) {
    return trimmed;
  }
  let resolved: URL;
  try {
    resolved = new URL(trimmed, state.baseUrl);
  } catch {
    return null;
  }
  if (resolved.protocol === "data:") {
    return trimmed;
  }
  if (resolved.protocol === "http:" || resolved.protocol === "https:") {
    return isBookUrl(resolved, state.context) ? resolved.href : null;
  }
  return null;
}

function getPurifier(): DOMPurify {
  if (purifier) {
    return purifier;
  }
  const instance = createDOMPurify(window);
  instance.setConfig({
    ALLOWED_TAGS: TAGS,
    ALLOWED_ATTR: ALL_ATTRIBUTES,
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP: ALLOWED_URI,
    FORBID_CONTENTS: CLEAN_CONTENT_TAGS,
    FORCE_BODY: true,
    KEEP_CONTENT: true,
    RETURN_DOM: true,
  });
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one allowlist hook mirroring the Rust ammonia config.
  instance.addHook("uponSanitizeAttribute", (node, event) => {
    const state = active;
    if (!state) {
      event.keepAttr = false;
      return;
    }
    const tag = node.nodeName.toLowerCase();
    const name = event.attrName;
    if (!(GENERIC.has(name) || PER_TAG.get(tag)?.has(name))) {
      event.keepAttr = false;
      return;
    }
    if (name === "style") {
      if (UNSAFE_STYLE.test(event.attrValue)) {
        event.keepAttr = false;
      }
      return;
    }
    if (tag === "a" && name === "href") {
      // The token is applied through `attrValue`; `forceKeepAttr` would keep
      // the original destination instead of the rewritten value.
      const token = registerLink(event.attrValue, state);
      if (token === null) {
        event.keepAttr = false;
      } else {
        event.attrValue = token;
      }
      return;
    }
    if (URL_ATTRIBUTES.has(name)) {
      const resolved = resolveResourceUrl(event.attrValue, state);
      if (resolved === null) {
        event.keepAttr = false;
      } else {
        event.attrValue = resolved;
      }
    }
  });
  purifier = instance;
  return instance;
}

/** Sanitize an HTML fragment string into a detached body element. */
export function sanitize(
  html: string,
  baseUrl: string,
  context: RenderContext
): HTMLElement {
  const instance = getPurifier();
  active = { baseUrl, context };
  try {
    return instance.sanitize(html, { RETURN_DOM: true }) as HTMLElement;
  } finally {
    active = null;
  }
}

// ---------------------------------------------------------------------------
// Document analysis

function hasParserError(doc: Document): boolean {
  return (
    !doc.documentElement || doc.getElementsByTagName("parsererror").length > 0
  );
}

export function parseDocument(text: string): Document {
  const parser = new DOMParser();
  let doc: Document | null = null;
  try {
    doc = parser.parseFromString(text, "application/xhtml+xml");
  } catch {
    doc = null;
  }
  if (!doc || hasParserError(doc)) {
    doc = parser.parseFromString(text, "text/html");
  }
  return doc;
}

function localName(element: Element): string {
  return (element.localName || element.nodeName).toLowerCase();
}

function findBody(doc: Document): Element | null {
  if (doc.body) {
    return doc.body;
  }
  const root = doc.documentElement;
  if (!root) {
    return null;
  }
  for (const child of root.children) {
    if (localName(child) === "body") {
      return child;
    }
  }
  return null;
}

function elementAttribute(
  element: Element | null,
  names: string[]
): string | null {
  if (!element) {
    return null;
  }
  for (const name of names) {
    const value = element.getAttribute(name)?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

export function documentLanguage(doc: Document): string | null {
  return (
    elementAttribute(findBody(doc), ["lang", "xml:lang"]) ??
    elementAttribute(doc.documentElement, ["lang", "xml:lang"])
  );
}

export function documentDirection(doc: Document): Chapter["direction"] {
  const value = (
    elementAttribute(findBody(doc), ["dir"]) ??
    elementAttribute(doc.documentElement, ["dir"])
  )?.toLowerCase();
  return value === "ltr" || value === "rtl" || value === "auto" ? value : null;
}

export function extractStylesheets(
  doc: Document,
  baseUrl: string,
  prefix: string
): string[] {
  const stylesheets: string[] = [];
  for (const link of doc.querySelectorAll("link")) {
    const rel = link.getAttribute("rel") ?? "";
    if (
      !rel
        .split(WHITESPACE)
        .some((value) => value.toLowerCase() === "stylesheet")
    ) {
      continue;
    }
    const href = link.getAttribute("href");
    if (!href) {
      continue;
    }
    let resolved: string;
    try {
      resolved = new URL(href.trim(), baseUrl).href;
    } catch {
      continue;
    }
    if (resolved.startsWith(prefix) && !stylesheets.includes(resolved)) {
      stylesheets.push(resolved);
    }
  }
  return stylesheets;
}

export function extractInlineStyles(doc: Document): string[] {
  return [...doc.querySelectorAll("style")].map(
    (style) => style.textContent ?? ""
  );
}

/**
 * Serialize the body (or, for documents without one such as SVG pages, the
 * root element) as an HTML fragment. Nodes are imported into an HTML document
 * first so the serialization is HTML, not XML — that is how the sanitizer and
 * the reader will parse it again.
 */
export function documentBodyHtml(doc: Document): string {
  const host = document.implementation.createHTMLDocument("");
  const wrapper = host.createElement("div");
  const body = findBody(doc);
  if (body) {
    for (const child of body.childNodes) {
      wrapper.append(host.importNode(child, true));
    }
  } else if (doc.documentElement) {
    wrapper.append(host.importNode(doc.documentElement, true));
  }
  return wrapper.innerHTML;
}

/** Port of `plain_text`: every tag boundary becomes a space, then whitespace collapses. */
export function plainText(root: Node): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.nodeValue ?? "");
      return;
    }
    if (
      node.nodeType !== Node.ELEMENT_NODE &&
      node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE
    ) {
      return;
    }
    parts.push(" ");
    for (const child of node.childNodes) {
      walk(child);
    }
    parts.push(" ");
  };
  walk(root);
  return parts.join("").replace(WHITESPACE, " ").trim();
}

// ---------------------------------------------------------------------------
// Chapter

export function renderDocument(
  context: RenderContext,
  text: string,
  path: string,
  id: string,
  title: string,
  index: number
): Chapter {
  const baseUrl = bookResourceUrl(context.bookId, path);
  const doc = parseDocument(text);
  const body = sanitize(documentBodyHtml(doc), baseUrl, context);
  return {
    baseUrl,
    direction: documentDirection(doc),
    html: body.innerHTML,
    id,
    index,
    inlineStyles: extractInlineStyles(doc),
    language: documentLanguage(doc),
    plainText: plainText(body),
    stylesheets: extractStylesheets(doc, baseUrl, context.prefix),
    title,
  };
}
