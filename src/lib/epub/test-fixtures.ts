/**
 * Test-only EPUB fixtures, ported from `crates/reader-epub/src/tests.rs` so
 * the browser engine is checked against the same publications as the Rust one.
 */
import { strToU8, type Zippable, zipSync } from "fflate";
import { deobfuscateIdpfFont, idpfFontKey } from "./idpf";

export const BOOK_ID = "0".repeat(64);

const CONTAINER_XML = `<?xml version="1.0"?>
  <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
    <rootfiles><rootfile full-path="EPUB/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
  </container>`;

export const ENCRYPTION_XML = `<?xml version="1.0"?>
  <encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
    <enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
      <enc:CipherData><enc:CipherReference URI="EPUB/fonts/test.otf"/></enc:CipherData>
    </enc:EncryptedData>
  </encryption>`;

export const EPUB3_OPF = `<?xml version="1.0"?>
  <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:identifier id="id">fixture-3</dc:identifier><dc:title>Fixture</dc:title><dc:language>en</dc:language>
    </metadata>
    <manifest>
      <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
      <item id="chapter" href="text/chapter.xhtml" media-type="application/xhtml+xml"/>
      <item id="css" href="styles/book.css" media-type="text/css"/>
      <item id="image" href="images/pixel.png" media-type="image/png"/>
      <item id="font" href="fonts/test.otf" media-type="application/vnd.ms-opentype"/>
    </manifest>
    <spine><itemref idref="nav" linear="no"/><itemref idref="chapter"/></spine>
  </package>`;

export const EPUB3_NAV = `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body><nav epub:type="toc"><ol><li><a href="text/chapter.xhtml#start">The beginning</a></li></ol></nav></body>
</html>`;

export const EPUB2_OPF = `<?xml version="1.0"?>
  <package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:identifier id="id">fixture-2</dc:identifier><dc:title>Fixture</dc:title><dc:language>en</dc:language>
    </metadata>
    <manifest>
      <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
      <item id="chapter" href="text/chapter.xhtml" media-type="application/xhtml+xml"/>
      <item id="css" href="styles/book.css" media-type="text/css"/>
      <item id="image" href="images/pixel.png" media-type="image/png"/>
      <item id="font" href="fonts/test.otf" media-type="application/vnd.ms-opentype"/>
    </manifest>
    <spine toc="ncx"><itemref idref="chapter"/></spine>
  </package>`;

export const EPUB2_NCX = `<?xml version="1.0"?>
  <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
    <head><meta name="dtb:uid" content="fixture-2"/></head><docTitle><text>Fixture</text></docTitle>
    <navMap><navPoint id="chapter"><navLabel><text>The beginning</text></navLabel><content src="text/chapter.xhtml#start"/></navPoint></navMap>
  </ncx>`;

export const SVG_SPINE_OPF = `<?xml version="1.0"?>
  <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">svg-fixture</dc:identifier><dc:title>SVG Fixture</dc:title><dc:language>en</dc:language></metadata>
    <manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="page" href="images/page.svg" media-type="image/svg+xml"/></manifest>
    <spine><itemref idref="page"/></spine>
  </package>`;

export const SVG_SPINE_NAV = `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="images/page.svg">A diagram page</a></li></ol></nav></body></html>`;

export const LINK_OPF = `<?xml version="1.0"?>
  <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">link-fixture</dc:identifier><dc:title>Link Fixture</dc:title><dc:language>en</dc:language></metadata>
    <manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="first" href="text/first.xhtml" media-type="application/xhtml+xml"/><item id="second" href="text/second.xhtml" media-type="application/xhtml+xml" fallback="alternate"/><item id="alternate" href="text/alternate.xhtml" media-type="application/xhtml+xml"/><item id="aux" href="text/aux.xhtml" media-type="application/xhtml+xml"/><item id="orphan" href="text/orphan.xhtml" media-type="application/xhtml+xml"/><item id="foreign" href="data/foreign.bin" media-type="application/x-custom" fallback="fallback-doc"/><item id="fallback-doc" href="text/fallback.xhtml" media-type="application/xhtml+xml"/></manifest>
    <spine><itemref idref="first"/><itemref idref="second"/><itemref idref="aux" linear="no"/><itemref idref="foreign" linear="no"/></spine>
  </package>`;

export const LINK_NAV = `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="text/first.xhtml">First</a></li><li><a href="text/second.xhtml">Second</a></li></ol></nav></body></html>`;

export const FALLBACK_OPF = `<?xml version="1.0"?>
  <package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">fallback-fixture</dc:identifier><dc:title>Fallback Fixture</dc:title><dc:language>en</dc:language></metadata>
    <manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="foreign" href="data/page.bin" media-type="application/x-custom" fallback="fallback"/><item id="fallback" href="text/fallback.xhtml" media-type="application/xhtml+xml"/></manifest>
    <spine toc="ncx"><itemref idref="foreign" linear="no"/></spine>
  </package>`;

export const FALLBACK_NCX = `<?xml version="1.0"?>
  <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="fallback-fixture"/></head><docTitle><text>Fallback Fixture</text></docTitle><navMap><navPoint id="fallback"><navLabel><text>Fallback content</text></navLabel><content src="text/fallback.xhtml"/></navPoint></navMap></ncx>`;

export const CHAPTER_XHTML = `<html xmlns="http://www.w3.org/1999/xhtml" lang="ar" dir="rtl"><head>
    <title>Fallback heading</title>
    <link rel="stylesheet" href="../styles/book.css"/>
    <style>.inline { font-style: italic }</style>
  </head><body><h1>Fallback heading</h1><p class="inline">Body</p>
    <img src="../images/pixel.png" alt="pixel"/>
    <svg viewBox="0 0 1 1"><defs><path id="mark" d="M0 0L1 1"/></defs><use href="#mark"/></svg>
    <script>throw new Error('must not run')</script>
  </body></html>`;

export const FIRST_XHTML = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p id="local">First</p><a name="legacy-note"></a><a href="second.xhtml#destination">Next section</a><a href="#local">This section</a><a href="https://example.com/docs?q=1#reference">Reference</a><a href="#legacy-note">Legacy note</a><a href="https://user@example.com/private">Credentials</a><a href="mailto:author@example.com">Email</a><a href="file:///etc/passwd">Unsafe</a><a href="aux.xhtml#aux">Non-linear</a><a href="orphan.xhtml#orphan">Non-spine</a><a href="../data/foreign.bin#fallback">Fallback alias</a><a href="alternate.xhtml#alternate">Explicit alternate</a></body></html>`;

export type FixtureFiles = Record<string, string | Uint8Array>;

/** Build an EPUB archive: stored `mimetype` first, everything else deflated. */
export function buildEpub(files: FixtureFiles): Uint8Array {
  const zip: Zippable = {
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(CONTAINER_XML),
  };
  for (const [name, content] of Object.entries(files)) {
    zip[name] = typeof content === "string" ? strToU8(content) : content;
  }
  return zipSync(zip, { level: 6 });
}

export function toBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes as BlobPart], { type: "application/epub+zip" });
}

export async function obfuscatedFont(identifier: string): Promise<Uint8Array> {
  const key = await idpfFontKey(identifier);
  return deobfuscateIdpfFont(strToU8("OTTOfixture-font"), key);
}

export async function fixtureEpub(epub3: boolean): Promise<Uint8Array> {
  const identifier = epub3 ? "fixture-3" : "fixture-2";
  return buildEpub({
    "META-INF/encryption.xml": ENCRYPTION_XML,
    "EPUB/text/chapter.xhtml": CHAPTER_XHTML,
    "EPUB/styles/book.css":
      "@font-face { font-family: test; src: url('../fonts/test.otf'); } body { font-family: test; }",
    "EPUB/images/pixel.png": "not-a-real-image",
    "EPUB/fonts/test.otf": await obfuscatedFont(identifier),
    ...(epub3
      ? { "EPUB/content.opf": EPUB3_OPF, "EPUB/nav.xhtml": EPUB3_NAV }
      : { "EPUB/content.opf": EPUB2_OPF, "EPUB/toc.ncx": EPUB2_NCX }),
  });
}

export function svgFixture(): Uint8Array {
  return buildEpub({
    "EPUB/content.opf": SVG_SPINE_OPF,
    "EPUB/nav.xhtml": SVG_SPINE_NAV,
    "EPUB/images/page.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><title>A diagram page</title><circle cx="30" cy="50" r="20"/><rect x="80" y="30" width="50" height="40"/><text x="10" y="95">A diagram page</text><script>throw 1</script></svg>`,
  });
}

export function linkFixture(): Uint8Array {
  return buildEpub({
    "EPUB/content.opf": LINK_OPF,
    "EPUB/nav.xhtml": LINK_NAV,
    "EPUB/text/first.xhtml": FIRST_XHTML,
    "EPUB/text/second.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="destination">Second</h1></body></html>`,
    "EPUB/text/aux.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml"><body><p id="aux">Non-linear content</p></body></html>`,
    "EPUB/text/orphan.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml"><body><p id="orphan">Non-spine content</p></body></html>`,
    "EPUB/data/foreign.bin": "foreign",
    "EPUB/text/fallback.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml"><body><p id="fallback">Readable fallback</p></body></html>`,
    "EPUB/text/alternate.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml"><body><p id="alternate">Explicit alternate content</p></body></html>`,
  });
}

export function fallbackFixture(): Uint8Array {
  return buildEpub({
    "EPUB/content.opf": FALLBACK_OPF,
    "EPUB/toc.ncx": FALLBACK_NCX,
    "EPUB/data/page.bin": "foreign",
    "EPUB/text/fallback.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Readable fallback</p></body></html>`,
  });
}

export const ANCHOR_HREFS = /<a\b[^>]*href="([^"]+)"/gu;

export function hrefsIn(html: string): string[] {
  return [...html.matchAll(ANCHOR_HREFS)].map((match) => match[1]);
}
