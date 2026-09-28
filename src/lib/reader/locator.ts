import type { ChapterPage } from "@/lib/reader/types";

/** UTF-16 offsets in the chapter's rendered source text, independent of pages. */
export interface ContentLocator {
  chapterId: string;
  end: number;
  quote: string;
  start: number;
}

export interface ReaderSelection {
  locator: ContentLocator;
  text: string;
}

export const MAX_SOURCE_OFFSET = 64 * 1024 * 1024;

export function validateLocator(
  locator: ContentLocator,
  chapterId: string,
  sourceText: string,
  allowPoint = false
): string | null {
  if (
    !locator ||
    typeof locator.chapterId !== "string" ||
    typeof locator.quote !== "string" ||
    locator.chapterId !== chapterId
  ) {
    return "The note belongs to a different chapter.";
  }
  if (
    !(
      Number.isSafeInteger(locator.start) && Number.isSafeInteger(locator.end)
    ) ||
    locator.start < 0 ||
    locator.end < locator.start ||
    (!allowPoint && locator.start === locator.end) ||
    locator.end > MAX_SOURCE_OFFSET ||
    locator.end > sourceText.length
  ) {
    return "The note points outside this chapter.";
  }
  if (
    locator.quote &&
    sourceText.slice(locator.start, locator.end) !== locator.quote
  ) {
    return "The saved passage no longer matches this chapter.";
  }
  return null;
}

interface TextSegment {
  end: number;
  start: number;
}

const segments = new WeakMap<Text, TextSegment>();

export function registerTextSegment(node: Text, start: number, end: number) {
  segments.set(node, { start, end });
}

function decorateClonedText(node: Text, highlights: ContentLocator[]) {
  const segment = segments.get(node);
  if (!segment) {
    return;
  }
  const overlaps = highlights.filter(
    (item) => item.start < segment.end && item.end > segment.start
  );
  if (!overlaps.length) {
    return;
  }
  const boundaries = new Set([0, node.length]);
  for (const item of overlaps) {
    boundaries.add(Math.max(0, item.start - segment.start));
    boundaries.add(Math.min(node.length, item.end - segment.start));
  }
  const cuts = [...boundaries].sort((a, b) => a - b);
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < cuts.length - 1; index += 1) {
    const start = cuts[index];
    const end = cuts[index + 1];
    const piece = document.createTextNode(node.data.slice(start, end));
    registerTextSegment(piece, segment.start + start, segment.start + end);
    const covered = overlaps.some(
      (item) =>
        item.start < segment.start + end && item.end > segment.start + start
    );
    if (covered) {
      const mark = document.createElement("mark");
      mark.className = "chapter-annotation-mark";
      mark.append(piece);
      fragment.append(mark);
    } else {
      fragment.append(piece);
    }
  }
  node.replaceWith(fragment);
}

/** Clone a measured page without losing the source offsets on its text nodes. */
export function clonePageContent(
  source: HTMLElement,
  fallbackHighlights: ContentLocator[] = []
): HTMLElement {
  const clone = source.cloneNode(true) as HTMLElement;
  const originals = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
  const copies = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  const decorated: Text[] = [];
  while (originals.nextNode() && copies.nextNode()) {
    const segment = segments.get(originals.currentNode as Text);
    if (segment) {
      const copy = copies.currentNode as Text;
      segments.set(copy, segment);
      decorated.push(copy);
    }
  }
  if (fallbackHighlights.length) {
    for (const node of decorated) {
      decorateClonedText(node, fallbackHighlights);
    }
  }
  return clone;
}

/** Returns null for selections outside one rendered chapter or synthetic UI. */
export function locatorForSelection(
  selection: Selection | null,
  sourceText?: string,
  expectedChapterId?: string
): ReaderSelection | null {
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (
    !(
      range.startContainer instanceof Text && range.endContainer instanceof Text
    )
  ) {
    return null;
  }
  const start = segments.get(range.startContainer);
  const end = segments.get(range.endContainer);
  const startPage =
    range.startContainer.parentElement?.closest(".chapter-page");
  const endPage = range.endContainer.parentElement?.closest(".chapter-page");
  const chapterId = startPage?.getAttribute("data-chapter-id");
  if (
    !(start && end && chapterId) ||
    (expectedChapterId && chapterId !== expectedChapterId) ||
    endPage?.getAttribute("data-chapter-id") !== chapterId
  ) {
    return null;
  }
  const from = start.start + range.startOffset;
  const to = end.start + range.endOffset;
  if (from >= to || to > end.end) {
    return null;
  }
  if (sourceText !== undefined && to > sourceText.length) {
    return null;
  }
  const text = selection.toString();
  return {
    locator: {
      chapterId,
      start: from,
      end: to,
      quote: sourceText?.slice(from, to) ?? text,
    },
    text,
  };
}

export function locatorAtPage(
  chapterId: string,
  page: ChapterPage
): ContentLocator {
  return {
    chapterId,
    start: page.startOffset,
    end: page.startOffset,
    quote: "",
  };
}

export function pageForLocator(
  pages: ChapterPage[],
  locator: ContentLocator
): number {
  const index = pages.findIndex((page) => locator.start < page.endOffset);
  return index < 0 ? Math.max(0, pages.length - 1) : index;
}

/** Ranges for the browser Highlight API; annotations never modify EPUB markup. */
export function rangesForLocator(
  root: Element,
  locator: ContentLocator
): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const segment = segments.get(node);
    if (
      !segment ||
      segment.end <= locator.start ||
      segment.start >= locator.end
    ) {
      continue;
    }
    const range = document.createRange();
    range.setStart(node, Math.max(0, locator.start - segment.start));
    range.setEnd(node, Math.min(node.length, locator.end - segment.start));
    ranges.push(range);
  }
  return ranges;
}
