import type { ChapterPage, ReaderPage } from "@/lib/reader/types";

export interface PaginatedChapter {
  chapterIndex: number;
  pages: ChapterPage[];
}

export interface ChapterPageRange {
  chapterIndex: number;
  endPage: number;
  startPage: number;
}

export interface BookPageMap {
  chapters: ChapterPageRange[];
  pages: ReaderPage[];
}

/** Pages visible at once: 2 for a double-page spread, 1 on narrow screens. */
export type PagesPerView = 1 | 2;

/** Index of the last page visible when `pageIndex` is showing. */
function viewEnd(pageIndex: number, perView: PagesPerView): number {
  const index = Math.max(0, pageIndex);
  return perView === 1 ? index : 2 * Math.floor((index + 1) / 2);
}

export function buildBookPageMap(
  chapters: PaginatedChapter[],
  includeEnd = true
): BookPageMap {
  const pages: ReaderPage[] = [];
  const ranges: ChapterPageRange[] = [];
  let pageNumber = 1;

  for (const chapter of chapters) {
    const startPage = pages.length;
    for (const page of chapter.pages) {
      pages.push({
        kind: "text",
        chapterIndex: chapter.chapterIndex,
        page,
        number: pageNumber,
      });
      pageNumber += 1;
    }
    ranges.push({
      chapterIndex: chapter.chapterIndex,
      startPage,
      endPage: pages.length - 1,
    });
  }

  if (includeEnd && ranges.length) {
    pages.push({ kind: "end", chapterIndex: ranges.at(-1)?.chapterIndex ?? 0 });
  }
  if (pages.length % 2 === 0) {
    pages.push({ kind: "blank" });
  }

  return { pages, chapters: ranges };
}

export function chapterIndexAtPage(
  pageIndex: number,
  chapters: ChapterPageRange[],
  perView: PagesPerView = 2
): number | null {
  if (!chapters.length) {
    return null;
  }
  const visibleEnd = viewEnd(pageIndex, perView);
  for (let index = chapters.length - 1; index >= 0; index -= 1) {
    if (visibleEnd >= chapters[index].startPage) {
      return chapters[index].chapterIndex;
    }
  }
  return chapters[0].chapterIndex;
}

export function pageForChapterProgress(
  chapter: ChapterPageRange,
  progress: number
): number {
  const distance = Math.max(0, chapter.endPage - chapter.startPage);
  const normalized = Math.min(1, Math.max(0, progress));
  return chapter.startPage + Math.round(distance * normalized);
}

export function chapterProgressAtPage(
  pageIndex: number,
  chapter: ChapterPageRange,
  perView: PagesPerView = 2
): number {
  const visibleEnd = viewEnd(pageIndex, perView);
  const progressPage = Math.min(
    chapter.endPage,
    Math.max(chapter.startPage, visibleEnd)
  );
  return (
    (progressPage - chapter.startPage) /
    Math.max(1, chapter.endPage - chapter.startPage)
  );
}

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

export function pageForChapterFragment(
  chapters: PaginatedChapter[],
  ranges: ChapterPageRange[],
  chapterIndex: number,
  fragment: string
): number | null {
  const fragments = new Set([fragment, decodeFragment(fragment)]);
  const chapter = chapters.find((item) => item.chapterIndex === chapterIndex);
  const range = ranges.find((item) => item.chapterIndex === chapterIndex);
  if (!(chapter && range)) {
    return null;
  }
  const contentPage = chapter.pages.findIndex((page) =>
    page.anchors.some((anchor) => fragments.has(anchor))
  );
  return contentPage < 0 ? null : range.startPage + contentPage;
}
