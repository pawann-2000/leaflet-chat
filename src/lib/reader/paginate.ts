import { registerTextSegment } from "@/lib/reader/locator";
import type { ChapterPage } from "@/lib/reader/types";

const ATOMIC_TAGS = new Set([
  "audio",
  "br",
  "hr",
  "img",
  "math",
  "picture",
  "svg",
  "table",
  "video",
  "wbr",
]);
const SKIP_TAGS = new Set([
  "link",
  "meta",
  "noscript",
  "script",
  "style",
  "template",
  "title",
]);
const CONTINUED_CLASS = "chapter-copy__continued";

function createCopy(): HTMLElement {
  const copy = document.createElement("div");
  copy.className = "chapter-copy";
  return copy;
}

export function paginateChapter(
  body: HTMLElement,
  measurer: HTMLElement
): ChapterPage[] {
  const pages: ChapterPage[] = [];
  let copy = createCopy();
  let anchors: string[] = [];
  let sourceOffset = 0;
  let pageStartOffset = 0;
  const openSources: Element[] = [];
  let openClones: HTMLElement[] = [];

  measurer.replaceChildren(copy);

  const tip = (): HTMLElement => openClones.at(-1) ?? copy;
  const fits = (): boolean =>
    measurer.scrollHeight <= measurer.clientHeight + 1;
  const isEmpty = (): boolean =>
    !copy.textContent?.trim() &&
    copy.querySelector("img, svg, math, table, video, hr") === null;

  function collectAnchors(element: Element) {
    const id = element.getAttribute("id");
    if (id) {
      anchors.push(id);
    }
    if (element.tagName.toLowerCase() === "a") {
      const name = element.getAttribute("name");
      if (name) {
        anchors.push(name);
      }
    }
  }

  function collectAnchorsDeep(element: Element) {
    collectAnchors(element);
    for (const nested of element.querySelectorAll("[id], a[name]")) {
      collectAnchors(nested);
    }
  }

  function breakPage() {
    pages.push({
      content: copy,
      anchors,
      startOffset: pageStartOffset,
      endOffset: sourceOffset,
    });
    copy = createCopy();
    anchors = [];
    pageStartOffset = sourceOffset;
    measurer.replaceChildren(copy);
    let parent: HTMLElement = copy;
    openClones = openSources.map((source) => {
      const clone = source.cloneNode(false) as HTMLElement;
      clone.removeAttribute("id");
      clone.classList.add(CONTINUED_CLASS);
      parent.append(clone);
      parent = clone;
      return clone;
    });
  }

  function cutPoints(text: string): number[] {
    const points: number[] = [];
    const pattern = /\s+/gu;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      if (match.index > 0) {
        points.push(match.index);
      }
    }
    if (points.at(-1) !== text.length) {
      points.push(text.length);
    }
    return points;
  }

  function longestFitting(chunk: Text, text: string, points: number[]): number {
    let low = 0;
    let high = points.length - 1;
    let best = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      chunk.data = text.slice(0, points[middle]);
      if (fits()) {
        best = points[middle];
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return best;
  }

  function placeText(node: Text) {
    let text = node.data;
    while (text.length) {
      const chunk = document.createTextNode(text);
      tip().append(chunk);
      if (fits()) {
        registerTextSegment(chunk, sourceOffset, sourceOffset + text.length);
        sourceOffset += text.length;
        return;
      }

      let cut = longestFitting(chunk, text, cutPoints(text));
      if (cut === 0) {
        cut = longestFitting(
          chunk,
          text,
          Array.from({ length: text.length }, (_, index) => index + 1)
        );
      }
      if (cut > 0) {
        chunk.data = text.slice(0, cut);
        registerTextSegment(chunk, sourceOffset, sourceOffset + cut);
        sourceOffset += cut;
        text = text.slice(cut);
        if (!text) {
          return;
        }
        breakPage();
        continue;
      }

      chunk.remove();
      if (isEmpty()) {
        const overflow = document.createTextNode(text);
        tip().append(overflow);
        registerTextSegment(overflow, sourceOffset, sourceOffset + text.length);
        sourceOffset += text.length;
        return;
      }
      breakPage();
    }
  }

  function placeAtomic(element: Element) {
    const alone = isEmpty();
    const clone = element.cloneNode(true) as HTMLElement;
    tip().append(clone);
    if (!(fits() || alone)) {
      clone.remove();
      breakPage();
      tip().append(clone);
    }
    collectAnchorsDeep(element);
    const texts = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    while (texts.nextNode()) {
      const node = texts.currentNode as Text;
      registerTextSegment(node, sourceOffset, sourceOffset + node.length);
      sourceOffset += node.length;
    }
  }

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      placeText(node as Text);
      return;
    }
    if (!(node instanceof Element)) {
      return;
    }
    const tag = node.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) {
      return;
    }
    if (ATOMIC_TAGS.has(tag)) {
      placeAtomic(node);
      return;
    }

    const clone = node.cloneNode(false) as HTMLElement;
    tip().append(clone);
    openSources.push(node);
    openClones.push(clone);
    collectAnchors(node);

    for (const child of [...node.childNodes]) {
      walk(child);
    }

    openSources.pop();
    const placed = openClones.pop();
    if (placed && !placed.childNodes.length) {
      placed.remove();
    }
  }

  for (const child of [...body.childNodes]) {
    walk(child);
  }
  pages.push({
    content: copy,
    anchors,
    startOffset: pageStartOffset,
    endOffset: sourceOffset,
  });
  measurer.replaceChildren();

  const filled = pages.filter((page) => page.content.childNodes.length);
  return filled.length ? filled : [pages[0]];
}
