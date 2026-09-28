import type { Chapter } from "@/lib/types";

const STYLE_ID = "leaflet-publisher-styles";

const THEMED_PROPERTIES = [
  "color",
  "background",
  "background-color",
  "background-image",
  "-webkit-text-fill-color",
];

const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)/gu;
const CSS_IMPORT =
  /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)')\s*\)?[^;]*;/gu;

function dropThemedColours(rule: CSSRule): void {
  if (rule instanceof CSSStyleRule) {
    for (const property of THEMED_PROPERTIES) {
      rule.style.removeProperty(property);
    }
    return;
  }
  if ("cssRules" in rule) {
    for (const nested of (rule as CSSGroupingRule).cssRules) {
      dropThemedColours(nested);
    }
  }
}

function partition(css: string): { global: string[]; scoped: string[] } {
  const global: string[] = [];
  const scoped: string[] = [];
  const sheet = new CSSStyleSheet();
  try {
    sheet.replaceSync(css);
  } catch {
    return { global, scoped };
  }
  for (const rule of sheet.cssRules) {
    const stays =
      rule instanceof CSSFontFaceRule || rule instanceof CSSKeyframesRule;
    if (!stays) {
      dropThemedColours(rule);
    }
    (stays ? global : scoped).push(rule.cssText);
  }
  return { global, scoped };
}

/**
 * Publisher stylesheets are inlined into the application document, so any
 * relative `url()` they contain would resolve against the app instead of the
 * book. Rewrite them against the stylesheet's own URL first, and keep only
 * references that stay inside the book protocol (or are `data:` URIs);
 * anything else is dropped rather than allowed to reach the network.
 * `@import` is removed outright: the fetched sheet is the unit we scope.
 */
export function absolutizeStylesheet(
  css: string,
  stylesheetUrl: string
): string {
  let base: URL;
  try {
    base = new URL(stylesheetUrl);
  } catch {
    return css;
  }
  const bookPrefix = bookRootOf(base);
  if (!bookPrefix) {
    return css;
  }
  return css.replace(CSS_IMPORT, "").replace(CSS_URL, (match, dq, sq, bare) => {
    const raw = (dq ?? sq ?? bare ?? "").trim();
    if (!raw || raw.startsWith("data:") || raw.startsWith("#")) {
      return match;
    }
    try {
      const resolved = new URL(raw, base);
      if (resolved.href.startsWith(bookPrefix)) {
        return `url("${resolved.href}")`;
      }
    } catch {
      // fall through: unparsable references are dropped below
    }
    return 'url("")';
  });
}

/**
 * The per-book URL root a stylesheet lives under, in either host's scheme:
 * `leaflet-book://localhost/<id>/` on desktop, `https://origin/book/<id>/` on
 * the web. `null` for anything else, in which case nothing is rewritten.
 */
function bookRootOf(url: URL): string | null {
  const segments = url.pathname.split("/").filter(Boolean);
  if (url.protocol === "leaflet-book:" && segments.length >= 1) {
    return `${url.protocol}//${url.host}/${segments[0]}/`;
  }
  if (
    (url.protocol === "http:" || url.protocol === "https:") &&
    segments[0] === "book" &&
    segments.length >= 2
  ) {
    return `${url.origin}/book/${segments[1]}/`;
  }
  return null;
}

async function readStylesheet(
  href: string
): Promise<{ css: string; failed: boolean }> {
  try {
    const response = await fetch(href);
    return response.ok
      ? {
          css: absolutizeStylesheet(await response.text(), href),
          failed: false,
        }
      : { css: "", failed: true };
  } catch {
    return { css: "", failed: true };
  }
}

function styleElement(): HTMLStyleElement {
  const existing = document.getElementById(STYLE_ID);
  if (existing instanceof HTMLStyleElement) {
    return existing;
  }
  const element = document.createElement("style");
  element.id = STYLE_ID;
  document.head.append(element);
  return element;
}

export function removePublisherStyles(): void {
  document.getElementById(STYLE_ID)?.remove();
}

export async function applyPublisherStyles(
  chapters: Chapter[]
): Promise<{ failedStylesheets: number }> {
  const hrefs: string[] = [];
  const inline: string[] = [];
  for (const chapter of chapters) {
    for (const href of chapter.stylesheets) {
      if (!hrefs.includes(href)) {
        hrefs.push(href);
      }
    }
    for (const css of chapter.inlineStyles) {
      const resolved = absolutizeStylesheet(css, chapter.baseUrl);
      if (!inline.includes(resolved)) {
        inline.push(resolved);
      }
    }
  }

  const fetched = await Promise.all(hrefs.map(readStylesheet));
  const failedStylesheets = fetched.filter((item) => item.failed).length;
  const sources = [...fetched.map((item) => item.css), ...inline];
  const global: string[] = [];
  const scoped: string[] = [];
  for (const css of sources) {
    const part = partition(css);
    global.push(...part.global);
    scoped.push(...part.scoped);
  }

  if (!(global.length || scoped.length)) {
    removePublisherStyles();
    return { failedStylesheets };
  }
  styleElement().textContent = [
    ...global,
    `@layer publisher { @scope (.chapter-copy) {\n${scoped.join("\n")}\n} }`,
  ].join("\n");
  return { failedStylesheets };
}
