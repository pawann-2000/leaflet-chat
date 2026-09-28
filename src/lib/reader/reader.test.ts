import { describe, expect, it } from "vitest";
import type { Chapter } from "@/lib/types";
import { buildBookPageMap, pageForChapterFragment } from "./book-pages";
import { chapterBody } from "./chapter-content";
import {
  clonePageContent,
  locatorForSelection,
  pageForLocator,
  rangesForLocator,
  validateLocator,
} from "./locator";
import { paginateChapter } from "./paginate";

const chapter: Chapter = {
  baseUrl: "",
  direction: null,
  html: '<p id="opening">Alpha beta gamma delta epsilon zeta eta theta.</p>',
  id: "chapter-one",
  index: 0,
  inlineStyles: [],
  language: null,
  plainText: "Alpha beta gamma delta epsilon zeta eta theta.",
  stylesheets: [],
  title: "Synthetic heading must not appear",
};

function layout(limit: number) {
  const measurer = document.createElement("div");
  Object.defineProperty(measurer, "clientHeight", { value: limit });
  Object.defineProperty(measurer, "scrollHeight", {
    get() {
      return this.textContent?.length ?? 0;
    },
  });
  return paginateChapter(chapterBody(chapter), measurer);
}

describe("EPUB page source and stable locators", () => {
  it("keeps the actual chapter body without manufacturing a title or cover", () => {
    expect(chapterBody(chapter).querySelector("h1")).toBeNull();
    const pages = layout(14);
    const map = buildBookPageMap([{ chapterIndex: 0, pages }], false);
    expect(map.pages[0].kind).toBe("text");
    expect(
      pageForChapterFragment(
        [{ chapterIndex: 0, pages }],
        map.chapters,
        0,
        "opening"
      )
    ).toBe(0);
    expect(pages.map((page) => page.content.textContent).join("")).toBe(
      chapter.plainText
    );
  });

  it("resolves a selection to the same source text after pagination changes", () => {
    const pages = layout(13);
    const sourceText = pages
      .map((page) => page.content.textContent ?? "")
      .join("");
    const pageIndex = pages.findIndex((page) =>
      page.content.textContent?.includes("beta")
    );
    const host = document.createElement("div");
    host.className = "chapter-page";
    host.dataset.chapterId = chapter.id;
    host.append(clonePageContent(pages[pageIndex].content));
    document.body.append(host);
    const text = [...host.querySelectorAll("p")]
      .flatMap((paragraph) => {
        const walker = document.createTreeWalker(
          paragraph,
          NodeFilter.SHOW_TEXT
        );
        const nodes: Text[] = [];
        while (walker.nextNode()) {
          nodes.push(walker.currentNode as Text);
        }
        return nodes;
      })
      .find((node) => node.data.includes("beta"));
    expect(text).toBeDefined();
    const range = document.createRange();
    const start = text?.data.indexOf("beta") ?? 0;
    range.setStart(text as Text, start);
    range.setEnd(text as Text, start + 4);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const selected = locatorForSelection(selection, sourceText);
    expect(selected?.locator.quote).toBe("beta");
    expect(selected?.locator.start).toBe(chapter.plainText.indexOf("beta"));
    expect(
      rangesForLocator(
        host,
        selected?.locator as NonNullable<typeof selected>["locator"]
      )
    ).toHaveLength(1);

    const fallbackHost = document.createElement("div");
    fallbackHost.className = "chapter-page";
    fallbackHost.dataset.chapterId = chapter.id;
    fallbackHost.append(
      clonePageContent(pages[pageIndex].content, [
        selected?.locator as NonNullable<typeof selected>["locator"],
      ])
    );
    document.body.append(fallbackHost);
    const marked = fallbackHost.querySelector("mark.chapter-annotation-mark");
    expect(marked?.textContent).toBe("beta");
    const markedRange = document.createRange();
    markedRange.setStart(marked?.firstChild as Text, 0);
    markedRange.setEnd(marked?.firstChild as Text, 4);
    selection?.removeAllRanges();
    selection?.addRange(markedRange);
    expect(locatorForSelection(selection, sourceText)?.locator.start).toBe(
      selected?.locator.start
    );

    const reflowed = layout(7);
    const reflowedPage = pageForLocator(
      reflowed,
      selected?.locator as NonNullable<typeof selected>["locator"]
    );
    expect(reflowed[reflowedPage].content.textContent).toContain("beta");
    expect(
      validateLocator(
        selected?.locator as NonNullable<typeof selected>["locator"],
        chapter.id,
        reflowed.map((page) => page.content.textContent ?? "").join("")
      )
    ).toBeNull();
    host.remove();
    fallbackHost.remove();
    selection?.removeAllRanges();
  });

  it("rejects stale quotes and out-of-range or cross-chapter notes", () => {
    const source = chapter.plainText;
    expect(
      validateLocator(
        { chapterId: chapter.id, start: 0, end: 5, quote: "wrong" },
        chapter.id,
        source
      )
    ).toContain("no longer matches");
    expect(
      validateLocator(
        { chapterId: chapter.id, start: 0, end: source.length + 1, quote: "" },
        chapter.id,
        source
      )
    ).toContain("outside");
    expect(
      validateLocator(
        { chapterId: "other", start: 0, end: 5, quote: "Alpha" },
        chapter.id,
        source
      )
    ).toContain("different chapter");
    expect(
      validateLocator(
        { chapterId: chapter.id, start: 5, end: 5, quote: "" },
        chapter.id,
        source,
        true
      )
    ).toBeNull();
  });
});
