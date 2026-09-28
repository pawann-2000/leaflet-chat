import { describe, expect, it } from "vitest";
import {
  createRenderContext,
  documentDirection,
  documentLanguage,
  extractStylesheets,
  INTERNAL_LINK_PREFIX,
  parseDocument,
  plainText,
  type RenderContext,
  registerLink,
  renderDocument,
  sanitize,
} from "./render";
import { BOOK_ID } from "./test-fixtures";
import { bookResourcePrefix, bookResourceUrl } from "./urls";

const CHAPTER = "/EPUB/text/chapter.xhtml";
const HREFS = /href="([^"]+)"/gu;
const SOURCES = /src="([^"]+)"/gu;
const INTERNAL = /^#leaflet-link-internal-/u;
const EXTERNAL = /^#leaflet-link-external-/u;

function clean(
  html: string,
  context: RenderContext = createRenderContext(BOOK_ID)
): string {
  return sanitize(html, bookResourceUrl(BOOK_ID, CHAPTER), context).innerHTML;
}

describe("sanitizer parity with ammonia", () => {
  it("removes active and remote content", () => {
    const output = clean(`
      <h1 onclick="steal()">A chapter</h1>
      <script>steal()</script>
      <img src="https://tracker.example/pixel.png" onerror="steal()">
      <form><input name="secret"></form>
    `);
    expect(output).toContain("A chapter");
    expect(output).not.toContain("script");
    expect(output).not.toContain("tracker.example");
    expect(output).not.toContain("onclick");
    expect(output).not.toContain("onerror");
    expect(output).not.toContain("form");
    expect(output).not.toContain("secret");
  });

  it("keeps scoped publication assets and formatting", () => {
    const image = bookResourceUrl(BOOK_ID, "/EPUB/image.png");
    const output = clean(`
      <p class="lead" style="font-variant: small-caps">
        <img src="${image}">
      </p>
    `);
    expect(output).toContain('class="lead"');
    expect(output).toContain("font-variant");
    expect(output).toContain(image);
  });

  it("rewrites relative asset references to the book prefix", () => {
    const output = clean(
      `<img src="../images/pixel.png"><svg><image xlink:href="../images/a.svg"/></svg>`
    );
    expect(output).toContain(
      bookResourceUrl(BOOK_ID, "/EPUB/images/pixel.png")
    );
    expect(output).toContain(bookResourceUrl(BOOK_ID, "/EPUB/images/a.svg"));
  });

  it("drops references that traverse out of the book prefix", () => {
    const output = clean(
      `<img src="../images/inside.png"><img src="../../../../etc/passwd"><img src="/other/../secret.png"><img src="//evil.example/x.png">`
    );
    const prefix = bookResourcePrefix(BOOK_ID);
    const sources = [...output.matchAll(SOURCES)].map((match) => match[1]);
    expect(sources).toEqual([
      bookResourceUrl(BOOK_ID, "/EPUB/images/inside.png"),
    ]);
    for (const source of sources) {
      expect(source.startsWith(prefix)).toBe(true);
    }
    expect(output).not.toContain("passwd");
    expect(output).not.toContain("secret");
    expect(output).not.toContain("evil.example");
  });

  it("extracts only scoped stylesheets", () => {
    const doc = parseDocument(`<html><head>
      <link rel="stylesheet" href="${bookResourceUrl(BOOK_ID, "/EPUB/book.css")}">
      <link rel="Stylesheet" href="../styles/other.css">
      <link rel="stylesheet" href="https://tracker.example/book.css">
    </head><body></body></html>`);
    expect(
      extractStylesheets(
        doc,
        bookResourceUrl(BOOK_ID, CHAPTER),
        bookResourcePrefix(BOOK_ID)
      )
    ).toEqual([
      bookResourceUrl(BOOK_ID, "/EPUB/book.css"),
      bookResourceUrl(BOOK_ID, "/EPUB/styles/other.css"),
    ]);
  });

  it("retains safe inline svg", () => {
    const output = clean(`<svg viewBox="0 0 100 100">
      <defs><linearGradient id="paint" x1="0" y1="0" x2="1" y2="1"><stop offset="50%" stop-color="#fff"/></linearGradient></defs>
      <circle cx="20" cy="20" r="10" fill="url(#paint)"/>
      <rect x="35" y="10" width="20" height="20" rx="2"/>
      <ellipse cx="75" cy="20" rx="12" ry="8"/>
      <line x1="10" y1="50" x2="90" y2="50"/>
      <polyline points="10,90 50,60 90,90"/>
      <script>x()</script>
    </svg>`);
    for (const expected of [
      'viewBox="0 0 100 100"',
      'cx="20"',
      'cy="20"',
      'r="10"',
      'width="20"',
      'height="20"',
      'rx="2"',
      'x1="10"',
      'y2="50"',
      'points="10,90 50,60 90,90"',
      'offset="50%"',
      'stop-color="#fff"',
      "<linearGradient",
    ]) {
      expect(output, expected).toContain(expected);
    }
    expect(output).not.toContain("script");
  });

  it("body language and direction override document defaults", () => {
    const doc = parseDocument(
      `<html lang="en" dir="ltr"><body xml:lang="ar" dir="rtl"></body></html>`
    );
    expect(documentLanguage(doc)).toBe("ar");
    expect(documentDirection(doc)).toBe("rtl");
  });

  it("drops attributes outside the per-tag allowlist", () => {
    const output = clean(
      `<p href="x" colspan="2">a</p><table><tr><td colspan="2" src="y">b</td></tr></table><a href="#x" target="_blank" rel="noopener">c</a>`
    );
    expect(output).not.toContain('href="x"');
    expect(output).toContain("<p>a</p>");
    expect(output).toContain('<td colspan="2">b</td>');
    expect(output).not.toContain("src=");
    expect(output).not.toContain("target=");
    expect(output).not.toContain("rel=");
  });

  it("drops dangerous style declarations but keeps harmless ones", () => {
    const output = clean(
      `<p style="background: url(https://x/y.png)">a</p><p style="behavior: url(x.htc)">b</p><p style="color: red">c</p>`
    );
    expect(output).not.toContain("url(");
    expect(output).not.toContain("behavior");
    expect(output).toContain('style="color: red"');
  });

  it("tokenizes every anchor and never exposes the destination", () => {
    const context = createRenderContext(BOOK_ID);
    const output = clean(
      `<a href="second.xhtml#dest">a</a><a href="#local">b</a><a href="https://example.com/x">c</a><a href="mailto:me@example.com">d</a>`,
      context
    );
    expect(output).not.toContain("second.xhtml");
    expect(output).not.toContain("example.com");
    const tokens = [...output.matchAll(HREFS)].map((match) => match[1]);
    expect(tokens).toHaveLength(4);
    expect(tokens[0]).toMatch(INTERNAL);
    expect(tokens[1]).toMatch(INTERNAL);
    expect(tokens[2]).toMatch(EXTERNAL);
    expect(tokens[3]).toMatch(EXTERNAL);
    expect(context.links[tokens[0]]).toBe(
      `${bookResourceUrl(BOOK_ID, "/EPUB/text/second.xhtml")}#dest`
    );
    expect(context.links[tokens[2]]).toBe("https://example.com/x");
  });

  it("reuses link tokens after a chapter is evicted and rendered again", () => {
    const links: Record<string, string> = {};
    const first = clean(
      '<a href="second.xhtml#dest">Next</a>',
      createRenderContext(BOOK_ID, links)
    );
    const second = clean(
      '<a href="second.xhtml#dest">Next</a>',
      createRenderContext(BOOK_ID, links)
    );
    expect(second).toBe(first);
    expect(Object.keys(links)).toHaveLength(1);
  });

  it("does not reuse a malformed stored token for a rendered anchor", () => {
    const destination = `${bookResourceUrl(BOOK_ID, "/EPUB/text/second.xhtml")}#dest`;
    const links = { "#leaflet-link-internal-not-a-uuid": destination };
    const output = clean(
      '<a href="second.xhtml#dest">Next</a>',
      createRenderContext(BOOK_ID, links)
    );
    expect(output).not.toContain("not-a-uuid");
    expect(Object.keys(links)).toHaveLength(2);
  });

  it("drops javascript:, data:text/html, credentialed and file: anchors", () => {
    const output = clean(
      `<a href="javascript:alert(1)">a</a><a href="data:text/html,<script>alert(1)</script>">b</a><a href="https://user:pw@example.com/">c</a><a href="file:///etc/passwd">d</a><a href="JaVaScRiPt:alert(1)">e</a>`
    );
    expect(output).not.toContain("href=");
    expect(output).not.toContain("script");
    expect(output).toContain(">a</a>");
  });

  it("tokenizes anchors inside svg and strips remote xlink references", () => {
    const output = clean(
      `<svg><a href="https://example.com/"><text>x</text></a><image xlink:href="https://tracker.example/p.png"/><use xlink:href="#m"/></svg>`
    );
    expect(output).not.toContain("example.com");
    expect(output).not.toContain("tracker.example");
    expect(output).toContain("#leaflet-link-external-");
    expect(output).toContain('xlink:href="#m"');
  });

  it("ignores <base> and does not execute nested styles", () => {
    const output = clean(
      `<base href="https://evil.example/"><img src="a.png"><style>@import url(https://evil.example/x.css)</style><p>text</p>`
    );
    expect(output).toContain(bookResourceUrl(BOOK_ID, "/EPUB/text/a.png"));
    expect(output).not.toContain("evil.example");
    expect(output).not.toContain("@import");
    expect(output).not.toContain("<style");
  });

  it("survives mXSS through noscript", () => {
    const output = clean(
      `<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>`
    );
    expect(output).not.toContain("onerror");
    expect(output).not.toContain("alert");
  });

  it("removes clean-content elements with their text", () => {
    const output = clean(
      "<p>keep</p><audio>drop</audio><iframe>drop</iframe><object>drop</object><template>drop</template><font>kept text</font>"
    );
    expect(output).toContain("keep");
    expect(output).not.toContain("drop");
    expect(output).toContain("kept text");
    expect(output).not.toContain("<font");
  });
});

describe("plain text", () => {
  it("separates block boundaries and decodes entities", () => {
    const doc = parseDocument(
      "<html><body><h1>Fallback heading</h1><p>Body &amp; <em>more</em>&nbsp;here</p></body></html>"
    );
    expect(plainText(doc.body)).toBe("Fallback heading Body & more here");
  });
});

describe("link registry", () => {
  it("preserves encoded unicode fragments in opaque links", () => {
    const context = createRenderContext(BOOK_ID);
    const token = registerLink("second.xhtml#destinati%C3%B3n", {
      baseUrl: bookResourceUrl(BOOK_ID, "/EPUB/text/first.xhtml"),
      context,
    });
    expect(token).not.toBeNull();
    expect(token?.startsWith(INTERNAL_LINK_PREFIX)).toBe(true);
    expect(context.links[token as string]).toBe(
      `${bookResourceUrl(BOOK_ID, "/EPUB/text/second.xhtml")}#destinati%C3%B3n`
    );
  });

  it("rejects overlong links", () => {
    const context = createRenderContext(BOOK_ID);
    expect(
      registerLink(`x.xhtml#${"a".repeat(9000)}`, {
        baseUrl: bookResourceUrl(BOOK_ID, CHAPTER),
        context,
      })
    ).toBeNull();
  });
});

describe("renderDocument", () => {
  it("falls back to the html parser for malformed xhtml", () => {
    const context = createRenderContext(BOOK_ID);
    const chapter = renderDocument(
      context,
      `<html lang="fr"><body dir="auto"><p>unclosed<p>second</body></html>`,
      CHAPTER,
      "c1",
      "Title",
      3
    );
    expect(chapter.language).toBe("fr");
    expect(chapter.direction).toBe("auto");
    expect(chapter.plainText).toBe("unclosed second");
    expect(chapter.index).toBe(3);
    expect(chapter.id).toBe("c1");
    expect(chapter.baseUrl).toBe(bookResourceUrl(BOOK_ID, CHAPTER));
  });

  it("renders svg documents as a whole", () => {
    const context = createRenderContext(BOOK_ID);
    const chapter = renderDocument(
      context,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Diagram</title><circle cx="3" cy="3" r="2"/></svg>`,
      "/EPUB/images/page.svg",
      "page",
      "Diagram",
      0
    );
    expect(chapter.html).toContain("<svg");
    expect(chapter.html).toContain('cx="3"');
    expect(chapter.plainText).toContain("Diagram");
  });
});
