import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deobfuscateIdpfFont } from "./idpf";
import {
  EpubError,
  importEpub,
  openedPublication,
  type PublicationLink,
  renderStoredBook,
  renderStoredChapter,
  resolvePublicationLink,
} from "./index";
import {
  buildEpub,
  fallbackFixture,
  fixtureEpub,
  hrefsIn,
  linkFixture,
  svgFixture,
  toBlob,
} from "./test-fixtures";
import { bookResourcePrefix, bookResourceUrl } from "./urls";
import { decodeText, readEntryFromBlob } from "./zip";

const EXAMPLE_EPUB =
  "/home/lion/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/rbook-0.7.10/tests/ebooks/example.epub";

async function errorCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof EpubError) {
      return error.code;
    }
    throw error;
  }
  return "ok";
}

const HEX_ID = /^[0-9a-f]{64}$/u;

function internal(link: PublicationLink) {
  if (link.kind !== "internal") {
    throw new Error("expected an internal link");
  }
  return link;
}

function external(link: PublicationLink) {
  if (link.kind !== "external") {
    throw new Error("expected an external link");
  }
  return link;
}

describe("importEpub", () => {
  it("preserves nested TOC fragments and resolves supplementary documents", async () => {
    const archive = buildEpub({
      "EPUB/content.opf": `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="one" href="text/one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="text/two.xhtml" media-type="application/xhtml+xml"/><item id="notes" href="text/notes.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>`,
      "EPUB/nav.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="text/one.xhtml#start"><em>Opening</em></a><ol><li><a href="text/one.xhtml#second">Another section</a></li></ol></li><li><a href="text/notes.xhtml#note">Notes</a></li></ol></nav></body></html>`,
      "EPUB/text/one.xhtml": `<html><body><p id="start">Start</p><p id="second">Second</p></body></html>`,
      "EPUB/text/two.xhtml": "<html><body><p>Two</p></body></html>",
      "EPUB/text/notes.xhtml": `<html><body><p id="note">Note</p></body></html>`,
    });
    const { book, file, render } = await importEpub(
      toBlob(archive),
      "nested.epub"
    );
    const opened = openedPublication(book, render);
    expect(
      opened.book.navigation.map(({ title, chapterIndex, fragment, depth }) => [
        title,
        chapterIndex,
        fragment,
        depth,
      ])
    ).toEqual([
      ["Opening", 0, "start", 0],
      ["Another section", 0, "second", 1],
      ["Notes", null, "note", 0],
    ]);
    expect(opened.book.chapters.map(({ id }) => id)).toEqual(["one", "two"]);
    expect(
      opened.book.documents.map(({ id, chapterIndex }) => [id, chapterIndex])
    ).toEqual([
      ["nav", null],
      ["one", 0],
      ["two", 1],
      ["notes", null],
    ]);
    expect((await renderStoredChapter(book, file, render, 0)).plainText).toBe(
      "Start Second"
    );
    const note = internal(
      await resolvePublicationLink(
        book,
        file,
        render,
        opened.book.navigation[2].link
      )
    );
    expect(note.chapterIndex).toBeNull();
    expect(note.fragment).toBe("note");
    expect(note.chapter.plainText).toBe("Note");
  });

  it("uses every spine chapter when TOC links are unsafe or unreachable", async () => {
    const archive = buildEpub({
      "EPUB/content.opf": `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="one" href="text/one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="text/two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>`,
      "EPUB/nav.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="https://evil.test/EPUB/text/one.xhtml">External</a></li><li><a href="file:///EPUB/text/one.xhtml">Local scheme</a></li><li><a href="text/missing.xhtml">Missing</a></li><li><a href="text/one.xhtml?query=1">Query</a></li><li><a href="text/one.xhtml#%GG">Malformed fragment</a></li></ol></nav></body></html>`,
      "EPUB/text/one.xhtml": "<html><body><p>One</p></body></html>",
      "EPUB/text/two.xhtml": "<html><body><p>Two</p></body></html>",
    });
    const { book, file, render } = await importEpub(
      toBlob(archive),
      "invalid-toc.epub"
    );
    expect(
      render.navigation.map(({ id, title, depth, chapterIndex }) => [
        id,
        title,
        depth,
        chapterIndex,
      ])
    ).toEqual([
      ["spine-0", "one", 0, 0],
      ["spine-1", "two", 0, 1],
    ]);
    for (const entry of render.navigation) {
      const target = internal(
        await resolvePublicationLink(book, file, render, entry.link)
      );
      expect(target.chapterIndex).toBe(entry.chapterIndex);
    }
  });

  it("keeps NCX hierarchy and distinct sections in one document", async () => {
    const archive = buildEpub({
      "EPUB/content.opf": `<package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata/><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="one" href="text/one.xhtml" media-type="application/xhtml+xml"/></manifest><spine toc="ncx"><itemref idref="one"/></spine></package>`,
      "EPUB/toc.ncx": `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint><navLabel><text>First</text></navLabel><content src="text/one.xhtml#a"/><navPoint><navLabel><text>Second</text></navLabel><content src="text/one.xhtml#b"/></navPoint></navPoint></navMap></ncx>`,
      "EPUB/text/one.xhtml": `<html><body><p id="a">A</p><p id="b">B</p></body></html>`,
    });
    const { render } = await importEpub(toBlob(archive), "ncx.epub");
    expect(
      render.navigation.map(({ title, fragment, depth }) => [
        title,
        fragment,
        depth,
      ])
    ).toEqual([
      ["First", "a", 0],
      ["Second", "b", 1],
    ]);
  });

  it("opens epub 3 with nav and nested resources", async () => {
    const { book, file, render } = await importEpub(
      toBlob(await fixtureEpub(true)),
      "fixture.epub"
    );
    expect(book.title).toBe("Fixture");
    expect(book.language).toBe("en");
    expect(book.chapterCount).toBe(1);
    expect(book.id).toMatch(HEX_ID);
    expect(render.summaries[0].title).toBe("The beginning");

    const chapter = await renderStoredChapter(book, file, render, 0);
    expect(chapter.language).toBe("ar");
    expect(chapter.direction).toBe("rtl");
    expect(chapter.stylesheets).toHaveLength(1);
    expect(chapter.stylesheets[0].endsWith("/EPUB/styles/book.css")).toBe(true);
    expect(chapter.inlineStyles).toEqual([".inline { font-style: italic }"]);
    expect(chapter.html).toContain(bookResourcePrefix(book.id));
    expect(chapter.html).toContain("<svg");
    expect(chapter.html).toContain('href="#mark"');
    expect(chapter.html).not.toContain("script");

    expect(file.resources["/EPUB/styles/book.css"]?.mediaType).toBe("text/css");
    expect(file.resources["/EPUB/text/chapter.xhtml"]).toBeUndefined();
    expect(file.resources["/META-INF/container.xml"]).toBeUndefined();
    expect(file.resources["/EPUB/images/pixel.png"]?.mediaType).toBe(
      "image/png"
    );
    const font = file.resources["/EPUB/fonts/test.otf"];
    expect(font?.transform).toBe("idpf-font");
    expect(file.fontKey).toHaveLength(20);
    const raw = await readEntryFromBlob(
      file.blob,
      file.entries[font?.zipIndex ?? 0]
    );
    expect(
      decodeText(deobfuscateIdpfFont(raw, file.fontKey as Uint8Array))
    ).toBe("OTTOfixture-font");
  });

  it("opens epub 2 with ncx navigation", async () => {
    const { book, file, render } = await importEpub(
      toBlob(await fixtureEpub(false)),
      "fixture.epub"
    );
    expect(book.chapterCount).toBe(1);
    expect(render.summaries[0].title).toBe("The beginning");
    expect((await renderStoredChapter(book, file, render, 0)).plainText).toBe(
      "Fallback heading Body"
    );
  });

  it("opens svg spine documents", async () => {
    const { book, file, render } = await importEpub(
      toBlob(svgFixture()),
      "svg.epub"
    );
    expect(book.chapterCount).toBe(1);
    const chapter = await renderStoredChapter(book, file, render, 0);
    expect(chapter.html).toContain("<svg");
    expect(chapter.html).toContain('cx="30"');
    expect(chapter.html).toContain('r="20"');
    expect(chapter.html).toContain('width="50"');
    expect(chapter.html).toContain('height="40"');
    expect(chapter.plainText).toContain("A diagram page");
    expect(chapter.html).not.toContain("script");
  });

  it("follows spine fallbacks when every entry is non-linear", async () => {
    const { book, file, render } = await importEpub(
      toBlob(fallbackFixture()),
      "fallback.epub"
    );
    expect(book.chapterCount).toBe(1);
    expect(render.summaries[0].title).toBe("Fallback content");
    expect(
      (await renderStoredChapter(book, file, render, 0)).plainText
    ).toContain("Readable fallback");
  });

  it("plans the full reading order without eagerly rendering chapters", async () => {
    const { book, file, render } = await importEpub(
      toBlob(linkFixture()),
      "links.epub"
    );
    expect(render.chapters).toEqual([]);
    expect(render.summaries.map(({ index, title }) => [index, title])).toEqual([
      [0, "First"],
      [1, "Second"],
    ]);
    expect(render.summaries.map((summary) => summary.id)).toEqual([
      "first",
      "second",
    ]);
    const second = await renderStoredChapter(book, file, render, 1);
    expect(second.index).toBe(1);
    expect(second.plainText).toBe("Second");
    expect(render.chapters).toEqual([]);
    const first = await renderStoredChapter(book, file, render, 0);
    const linksAfterFirstLoad = Object.keys(render.links).length;
    expect((await renderStoredChapter(book, file, render, 0)).html).toBe(
      first.html
    );
    expect(Object.keys(render.links)).toHaveLength(linksAfterFirstLoad);
  });

  it("rejects archives without readable chapters", async () => {
    const archive = buildEpub({
      "EPUB/content.opf": `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest><item id="a" href="a.png" media-type="image/png"/></manifest><spine><itemref idref="a"/></spine></package>`,
    });
    expect(
      await errorCode(() => importEpub(toBlob(archive), "empty.epub"))
    ).toBe("no_readable_content");
  });

  it("rejects a missing spine document during metadata-first import", async () => {
    const archive = buildEpub({
      "EPUB/content.opf": `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest><item id="missing" href="missing.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="missing"/></spine></package>`,
    });
    expect(
      await errorCode(() => importEpub(toBlob(archive), "missing.epub"))
    ).toBe("parse");
  });

  it("rejects archives without a container", async () => {
    const { zipSync, strToU8 } = await import("fflate");
    const archive = zipSync({ mimetype: strToU8("application/epub+zip") });
    expect(await errorCode(() => importEpub(toBlob(archive), "bad.epub"))).toBe(
      "parse"
    );
  });

  it("produces the same render from stored records", async () => {
    const imported = await importEpub(
      toBlob(await fixtureEpub(true)),
      "fixture.epub"
    );
    const again = await renderStoredBook(imported.book, imported.file);
    expect(again.summaries).toEqual(imported.render.summaries);
    expect(again.navigationTargets).toEqual(imported.render.navigationTargets);
    expect(again.chapters).toEqual([]);
    expect(
      again.navigation.map(({ title, depth, fragment }) => [
        title,
        depth,
        fragment,
      ])
    ).toEqual(
      imported.render.navigation.map(({ title, depth, fragment }) => [
        title,
        depth,
        fragment,
      ])
    );
    expect(
      (await renderStoredChapter(imported.book, imported.file, again, 0))
        .plainText
    ).toBe(
      (
        await renderStoredChapter(
          imported.book,
          imported.file,
          imported.render,
          0
        )
      ).plainText
    );
  });

  it("rejects mismatched stored records before loading chapter bytes or links", async () => {
    const imported = await importEpub(toBlob(linkFixture()), "links.epub");
    const mismatchedBook = { ...imported.book, id: "f".repeat(64) };
    const linksBefore = { ...imported.render.links };
    expect(
      await errorCode(() =>
        renderStoredChapter(mismatchedBook, imported.file, imported.render, 0)
      )
    ).toBe("parse");
    expect(
      await errorCode(() => renderStoredBook(mismatchedBook, imported.file))
    ).toBe("parse");
    const redirected = {
      ...imported.render,
      spinePaths: [
        "/EPUB/text/orphan.xhtml",
        ...imported.render.spinePaths.slice(1),
      ],
    };
    expect(
      await errorCode(() =>
        renderStoredChapter(imported.book, imported.file, redirected, 0)
      )
    ).toBe("parse");
    expect(imported.render.links).toEqual(linksBefore);
  });

  it("builds the UI publication with a protocol cover url", async () => {
    const archive = buildEpub({
      "EPUB/content.opf": `<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">c</dc:identifier><dc:title> Covered </dc:title><dc:creator>Ann</dc:creator><dc:creator> </dc:creator><dc:creator>Bo</dc:creator><meta name="cover" content="cov"/></metadata><manifest><item id="cov" href="images/cover.jpg" media-type="image/jpeg"/><item id="c1" href="text/one.xhtml" media-type="application/xhtml+xml"/></manifest><spine page-progression-direction="rtl"><itemref idref="c1"/></spine></package>`,
      "EPUB/images/cover.jpg": "jpeg",
      "EPUB/text/one.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>One</p></body></html>`,
    });
    const { book, render } = await importEpub(toBlob(archive), "covered.epub");
    const opened = openedPublication(book, render);
    expect(opened.book.summary.title).toBe("Covered");
    expect(opened.book.summary.authors).toEqual(["Ann", "Bo"]);
    expect(opened.book.summary.pageDirection).toBe("right-to-left");
    expect(opened.book.summary.coverDataUrl).toBe(
      bookResourceUrl(book.id, "/EPUB/images/cover.jpg")
    );
    expect(opened.book.summary.sourcePath).toBe("covered.epub");
    expect(opened.book.chapters[0].title).toBe("one");
    expect(opened.chapters).toEqual([]);
    expect(opened.book.summary.fingerprint).toBe(book.id);
  });

  it("parses the rbook example publication", async () => {
    if (!existsSync(EXAMPLE_EPUB)) {
      return;
    }
    const bytes = readFileSync(EXAMPLE_EPUB);
    const { book, render, file } = await importEpub(
      toBlob(new Uint8Array(bytes)),
      "example.epub"
    );
    expect(book.title).toBe("Example EPUB");
    expect(book.authors).toEqual(["John Doe"]);
    expect(book.language).toBe("en");
    expect(book.pageDirection).toBe("left-to-right");
    // The webm "cover" falls back to the first image-typed entry.
    expect(book.coverPath).toBe("/EPUB/img/cover.avif");
    // Linear spine: toc, c1, c2 (cover and c1a are non-linear).
    expect(render.summaries.map((summary) => summary.id)).toEqual([
      "toc",
      "c1",
      "c2",
    ]);
    expect(render.chapters).toEqual([]);
    expect(file.resources["/file name with spaces.css"]?.mediaType).toBe(
      "text/css"
    );
    expect(
      render.navigationTargets["/EPUB/c1a.xhtml"]?.chapterIndex
    ).toBeNull();
    expect(
      render.navigationTargets["/EPUB/cover.xhtml"]?.chapterIndex
    ).toBeNull();
    for (let index = 0; index < book.chapterCount; index += 1) {
      const chapter = await renderStoredChapter(book, file, render, index);
      expect(chapter.html).not.toContain("<script");
      for (const href of hrefsIn(chapter.html)) {
        expect(href.startsWith("#leaflet-link-")).toBe(true);
        expect(render.links[href]).toBeDefined();
      }
    }
  });
});

describe("resolvePublicationLink", () => {
  it("resolves internal and external publication links", async () => {
    const { book, file, render } = await importEpub(
      toBlob(linkFixture()),
      "links.epub"
    );
    const chapter = await renderStoredChapter(book, file, render, 0);
    const hrefs = hrefsIn(chapter.html);
    expect(hrefs, chapter.html).toHaveLength(9);
    expect(chapter.html).toContain('name="legacy-note"');
    expect(chapter.html).not.toContain("https://example.com");
    expect(chapter.html).not.toContain("user@example.com");
    expect(chapter.html).not.toContain("file:///");

    const cross = internal(
      await resolvePublicationLink(book, file, render, hrefs[0])
    );
    expect(cross.chapterIndex).toBe(1);
    expect(cross.chapter.title).toBe("Second");
    expect(cross.fragment).toBe("destination");
    // Tokens stay resolvable.
    expect(
      (await resolvePublicationLink(book, file, render, hrefs[0])).kind
    ).toBe("internal");

    const local = internal(
      await resolvePublicationLink(book, file, render, hrefs[1])
    );
    expect(local.chapterIndex).toBe(0);
    expect(local.fragment).toBe("local");

    const reference = external(
      await resolvePublicationLink(book, file, render, hrefs[2])
    );
    expect(reference.url).toBe("https://example.com/docs?q=1#reference");
    expect(reference.trustOrigin).toBe("https://example.com");

    const legacy = internal(
      await resolvePublicationLink(book, file, render, hrefs[3])
    );
    expect(legacy.chapterIndex).toBe(0);
    expect(legacy.fragment).toBe("legacy-note");

    expect(
      await errorCode(() =>
        resolvePublicationLink(
          book,
          file,
          render,
          "#leaflet-link-internal-not-a-valid-token"
        )
      )
    ).toBe("invalid_link");
    expect(
      await errorCode(() =>
        resolvePublicationLink(
          book,
          file,
          render,
          `#leaflet-link-internal-${crypto.randomUUID()}`
        )
      )
    ).toBe("invalid_link");

    const email = external(
      await resolvePublicationLink(book, file, render, hrefs[4])
    );
    expect(email.url).toBe("mailto:author@example.com");
    expect(email.trustOrigin).toBeNull();
  });

  it("follows non-linear, non-spine and fallback targets", async () => {
    const { book, file, render } = await importEpub(
      toBlob(linkFixture()),
      "links.epub"
    );
    const hrefs = hrefsIn(
      (await renderStoredChapter(book, file, render, 0)).html
    );
    for (const [index, expected] of [
      [5, "Non-linear content"],
      [6, "Non-spine content"],
      [7, "Readable fallback"],
      [8, "Explicit alternate content"],
    ] as const) {
      const link = internal(
        await resolvePublicationLink(book, file, render, hrefs[index])
      );
      expect(link.chapterIndex).toBeNull();
      expect(link.chapter.plainText, link.chapter.html).toContain(expected);
    }
  });

  it("rejects links into other books and unknown documents", async () => {
    const { book, file, render } = await importEpub(
      toBlob(linkFixture()),
      "links.epub"
    );
    const foreign = `#leaflet-link-internal-${crypto.randomUUID()}`;
    render.links[foreign] = bookResourceUrl(
      "f".repeat(64),
      "/EPUB/text/first.xhtml"
    );
    expect(
      await errorCode(() => resolvePublicationLink(book, file, render, foreign))
    ).toBe("invalid_link");
    const missing = `#leaflet-link-internal-${crypto.randomUUID()}`;
    render.links[missing] = bookResourceUrl(
      book.id,
      "/EPUB/text/nowhere.xhtml"
    );
    expect(
      await errorCode(() => resolvePublicationLink(book, file, render, missing))
    ).toBe("link_not_found");
    const odd = `#leaflet-link-external-${crypto.randomUUID()}`;
    render.links[odd] = "ftp://example.com/x";
    expect(
      await errorCode(() => resolvePublicationLink(book, file, render, odd))
    ).toBe("unsupported_link");
  });
});
