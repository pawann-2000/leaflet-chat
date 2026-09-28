import type { Chapter } from "@/lib/types";

const cache = new Map<string, HTMLElement>();
let parser: DOMParser | undefined;
const LEAD_PARAGRAPH_CLASS = "chapter-copy__lead";

function isSmallOnlyParagraph(paragraph: HTMLParagraphElement): boolean {
  const meaningfulNodes = [...paragraph.childNodes].filter(
    (node) =>
      node.nodeType !== Node.TEXT_NODE || Boolean(node.textContent?.trim())
  );
  return (
    meaningfulNodes.length === 1 &&
    meaningfulNodes[0] instanceof HTMLElement &&
    meaningfulNodes[0].tagName.toLowerCase() === "small"
  );
}

function markLeadParagraph(body: HTMLElement): void {
  for (const paragraph of body.querySelectorAll("p")) {
    if (!(paragraph instanceof HTMLParagraphElement)) {
      continue;
    }
    if (!paragraph.textContent?.trim() || isSmallOnlyParagraph(paragraph)) {
      continue;
    }
    paragraph.classList.add(LEAD_PARAGRAPH_CLASS);
    return;
  }
}

export function chapterBody(chapter: Chapter): HTMLElement {
  const cached = cache.get(chapter.id);
  if (cached) {
    return cached.cloneNode(true) as HTMLElement;
  }

  parser ??= new DOMParser();
  const parsed = parser.parseFromString(chapter.html, "text/html");
  const body = document.importNode(parsed.body, true);

  if (!body.textContent?.trim() && chapter.plainText.trim()) {
    const fallback = document.createElement("p");
    fallback.textContent = chapter.plainText.trim();
    body.append(fallback);
  }
  markLeadParagraph(body);

  cache.set(chapter.id, body);
  return body.cloneNode(true) as HTMLElement;
}

export function forgetChapterContent(): void {
  cache.clear();
}
