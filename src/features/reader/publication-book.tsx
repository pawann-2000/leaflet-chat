import { ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/motion/button";
import {
  buildBookPageMap,
  chapterProgressAtPage,
  type PaginatedChapter,
  pageForChapterFragment,
  pageForChapterProgress,
} from "@/lib/reader/book-pages";
import {
  chapterBody,
  forgetChapterContent,
} from "@/lib/reader/chapter-content";
import {
  type ContentLocator,
  clonePageContent,
  locatorAtPage,
  locatorForSelection,
  pageForLocator,
  type ReaderSelection,
  rangesForLocator,
  validateLocator,
} from "@/lib/reader/locator";
import { paginateChapter } from "@/lib/reader/paginate";
import {
  applyPublisherStyles,
  removePublisherStyles,
} from "@/lib/reader/publisher-css";
import type { ChapterPage } from "@/lib/reader/types";
import type { Chapter, OpenedBook } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  type Leaf,
  TurnBook,
  useArrowTurns,
  useElementSize,
  useMediaQuery,
} from "./turn-book";

export interface ReaderAnnotation {
  id: string;
  kind: string;
  locator: ContentLocator;
  text: string;
}

export interface PublicationBookProps {
  annotations?: ReaderAnnotation[];
  book: OpenedBook;
  /** Already loaded chapters; the rest are fetched when opened. */
  chapters: Chapter[];
  currentIndex: number;
  fontScale: number;
  initialProgress?: number;
  loadChapter: (index: number) => Promise<Chapter>;
  navigationKey: number;
  onChapterChange: (index: number) => void;
  onChapterLoaded?: (chapter: Chapter) => void;
  /** The chapter finished laying out; `sourceText` is the text the locators index into. */
  onLaidOut?: (layout: {
    chapterId: string;
    sourceText: string;
    pages: number;
  }) => void;
  onLink: (href: string) => void;
  onLocation?: (locator: ContentLocator) => void;
  onLocatorError?: (locator: ContentLocator, reason: string) => void;
  /** The reader landed on a page (or spread); `words` counts the text now visible. */
  onPageShown?: (words: number) => void;
  onProgress: (chapterIndex: number, progress: number) => void;
  onReaderSelection?: (selection: ReaderSelection | null) => void;
  onSelection: (text: string) => void;
  /** Receives the stage element so overlays (selection toolbar) can anchor to it. */
  stageRef?: RefObject<HTMLElement | null>;
  targetFragment: string | null;
  targetLocator?: ContentLocator | null;
}

const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

function countVisibleWords(pages: ChapterPage[]): number {
  let words = 0;
  for (const page of pages) {
    words += (page.content.textContent ?? "").match(WORD)?.length ?? 0;
  }
  return words;
}

interface LaidChapter extends PaginatedChapter {
  chapter: Chapter;
  signature: string;
}

const EMPTY_ANNOTATIONS: ReaderAnnotation[] = [];
const SINGLE_PAGE_QUERY = "(max-width: 767px)";
let publisherQueue: Promise<unknown> = Promise.resolve();
let publisherGeneration = 0;
const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

function supportsTextHighlights(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof (window as Window & { Highlight?: unknown }).Highlight === "function"
  );
}

const graft =
  (content: HTMLElement, fallbackHighlights: ContentLocator[]) =>
  (host: HTMLDivElement | null) => {
    if (host) {
      host.replaceChildren(clonePageContent(content, fallbackHighlights));
    }
  };

async function decodeChapterImages(body: HTMLElement): Promise<number> {
  const images = [...body.querySelectorAll("img")];
  const decoded = await Promise.allSettled(
    images.map((image) =>
      typeof image.decode === "function" ? image.decode() : Promise.resolve()
    )
  );
  let failed = 0;
  for (const [index, result] of decoded.entries()) {
    if (result.status === "rejected") {
      images[index].alt ||= "Illustration unavailable";
      failed += 1;
    }
  }
  return failed;
}

function mediaNotice(failedImages: number, failedStylesheets: number) {
  const warnings: string[] = [];
  if (failedImages) {
    warnings.push(`${failedImages} illustrations could not be loaded`);
  }
  if (failedStylesheets) {
    warnings.push("some publisher styling is unavailable");
  }
  return warnings.length
    ? `${warnings.join("; ")}. This chapter may look incomplete.`
    : null;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: page transitions, asynchronous chapter layout, and source locators share one lifecycle.
export function PublicationBook(props: PublicationBookProps) {
  const {
    book,
    chapters,
    currentIndex,
    fontScale,
    navigationKey,
    targetFragment,
    targetLocator,
    annotations = EMPTY_ANNOTATIONS,
  } = props;
  const single = useMediaQuery(SINGLE_PAGE_QUERY);
  const perView = single ? 1 : 2;
  const stage = useRef<HTMLElement>(null);
  useImperativeHandle(props.stageRef, () => stage.current as HTMLElement, []);
  const frame = useRef<HTMLElement>(null);
  const measurer = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const loaded = useRef(new Map(chapters.map((item) => [item.index, item])));
  for (const item of chapters) {
    loaded.current.set(item.index, item);
  }
  const restoreProgress = useRef(clamp(props.initialProgress ?? 0, 0, 1));
  const location = useRef<ContentLocator | null>(null);
  const applied = useRef({ chapterIndex: -1, navigationKey: -1 });
  const boundary = useRef<"next" | "previous" | null>(null);
  const size = useElementSize(frame);
  const [chapter, setChapter] = useState<Chapter | null>(
    () => loaded.current.get(currentIndex) ?? null
  );
  const [laid, setLaid] = useState<LaidChapter | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [assetWarning, setAssetWarning] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [leaf, setLeaf] = useState(1);
  const [turning, setTurning] = useState(false);
  const [locatorWarning, setLocatorWarning] = useState<string | null>(null);
  const reportedInvalid = useRef(new Set<string>());

  const pageMap = useMemo(
    () =>
      buildBookPageMap(
        laid ? [laid] : [],
        currentIndex === book.chapters.length - 1
      ),
    [laid, currentIndex, book.chapters.length]
  );
  const textPages = laid?.pages ?? [];
  const sourceText = useMemo(
    () => textPages.map((page) => page.content.textContent ?? "").join(""),
    [textPages]
  );
  const { validAnnotations, invalidAnnotations } = useMemo(() => {
    const valid: ReaderAnnotation[] = [];
    const invalid: { item: ReaderAnnotation; reason: string }[] = [];
    for (const item of annotations) {
      if (!laid || item.locator.chapterId !== laid.chapter.id) {
        continue;
      }
      const reason = validateLocator(
        item.locator,
        laid.chapter.id,
        sourceText,
        item.kind === "bookmark"
      );
      if (reason) {
        invalid.push({ item, reason });
      } else {
        valid.push(item);
      }
    }
    return { validAnnotations: valid, invalidAnnotations: invalid };
  }, [annotations, laid, sourceText]);
  useEffect(() => {
    for (const { item, reason } of invalidAnnotations) {
      const key = `${item.id}:${laid?.chapter.id}:${reason}`;
      if (!reportedInvalid.current.has(key)) {
        reportedInvalid.current.add(key);
        latest.current.onLocatorError?.(item.locator, reason);
      }
    }
  }, [invalidAnnotations, laid]);
  const meaningfulCount =
    textPages.length +
    (currentIndex === book.chapters.length - 1 && laid ? 1 : 0);
  const leafCount = pageMap.pages.length;
  const hasPreviousChapter = currentIndex > 0;
  const hasNextChapter = currentIndex < book.chapters.length - 1;
  const atStart = leaf <= 1;
  const atEnd = leaf >= meaningfulCount;

  // biome-ignore lint/correctness/useExhaustiveDependencies: book identity and explicit retry must restart an in-flight chapter request.
  useEffect(() => {
    let cancelled = false;
    const cached = loaded.current.get(currentIndex);
    setLaid(null);
    setLoadError(null);
    setTurning(false);
    if (cached) {
      setChapter(cached);
      return;
    }
    setChapter(null);
    latest.current.loadChapter(currentIndex).then(
      (result) => {
        if (cancelled) {
          return;
        }
        if (
          result.index !== currentIndex ||
          result.id !== book.chapters[currentIndex]?.id
        ) {
          setLoadError(
            "The chapter did not match this book. Please try again."
          );
          return;
        }
        loaded.current.set(currentIndex, result);
        latest.current.onChapterLoaded?.(result);
        setChapter(result);
      },
      () => {
        if (!cancelled) {
          setLoadError("This chapter could not be opened. Please try again.");
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [book.summary.id, book.chapters, currentIndex, retry]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: book identity resets cached DOM and publisher CSS on reuse.
  useEffect(() => {
    forgetChapterContent();
    return () => {
      forgetChapterContent();
      removePublisherStyles();
    };
  }, [book.summary.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry remeasures a chapter after a failed resource or style load.
  useEffect(() => {
    const element = measurer.current;
    if (!(chapter && element) || size.width < 40 || size.height < 20) {
      return;
    }
    const signature = `${chapter.id}/${size.width}x${size.height}@${fontScale}/${perView}`;
    let cancelled = false;
    const generation = ++publisherGeneration;
    setLaid(null);
    setAssetWarning(null);
    const paginate = async () => {
      const styling = publisherQueue
        .catch(() => undefined)
        .then(() => applyPublisherStyles([chapter]));
      publisherQueue = styling;
      const styleResult = await styling;
      if (cancelled) {
        if (generation === publisherGeneration) {
          removePublisherStyles();
        }
        return;
      }
      await (document.fonts?.ready ?? Promise.resolve());
      const body = chapterBody(chapter);
      const failedImages = await decodeChapterImages(body);
      if (cancelled) {
        return;
      }
      setAssetWarning(mediaNotice(failedImages, styleResult.failedStylesheets));
      const pages = paginateChapter(body, element);
      if (!cancelled) {
        setLaid({ chapter, chapterIndex: chapter.index, pages, signature });
      }
    };
    paginate().catch(() => {
      if (!cancelled) {
        setLoadError("This chapter could not be laid out. Please try again.");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [chapter, fontScale, perView, size.width, size.height, retry]);

  useEffect(() => {
    if (laid) {
      latest.current.onLaidOut?.({
        chapterId: laid.chapter.id,
        sourceText,
        pages: textPages.length,
      });
    }
  }, [laid, sourceText, textPages.length]);

  const updateLocation = useCallback(
    (nextLeaf: number) => {
      if (!(laid && textPages.length)) {
        return;
      }
      const firstVisible =
        perView === 2 && nextLeaf > 1 ? nextLeaf - 2 : nextLeaf - 1;
      const pageIndex = clamp(firstVisible, 0, textPages.length - 1);
      const next = locatorAtPage(laid.chapter.id, textPages[pageIndex]);
      location.current = next;
      latest.current.onLocation?.(next);
      latest.current.onPageShown?.(
        countVisibleWords(textPages.slice(pageIndex, pageIndex + perView))
      );
      const range = pageMap.chapters[0];
      if (range) {
        latest.current.onProgress(
          laid.chapter.index,
          chapterProgressAtPage(pageIndex, range, perView)
        );
      }
    },
    [laid, pageMap, perView, textPages]
  );

  useEffect(() => {
    if (
      !laid ||
      laid.chapter.index !== currentIndex ||
      !pageMap.chapters.length
    ) {
      return;
    }
    const sameChapter = applied.current.chapterIndex === currentIndex;
    const sameNavigation = applied.current.navigationKey === navigationKey;
    let pageIndex = 0;
    if (boundary.current === "previous") {
      pageIndex = textPages.length - 1;
    } else if (boundary.current === "next") {
      pageIndex = 0;
    } else if (sameChapter && sameNavigation && location.current) {
      pageIndex = pageForLocator(textPages, location.current);
    } else if (targetLocator) {
      const reason = validateLocator(
        targetLocator,
        laid.chapter.id,
        sourceText,
        true
      );
      if (reason) {
        setLocatorWarning(reason);
        latest.current.onLocatorError?.(targetLocator, reason);
      } else {
        setLocatorWarning(null);
        pageIndex = pageForLocator(textPages, targetLocator);
      }
    } else if (targetFragment) {
      pageIndex =
        pageForChapterFragment(
          [laid],
          pageMap.chapters,
          currentIndex,
          targetFragment
        ) ?? 0;
    } else if (applied.current.chapterIndex === -1) {
      pageIndex = pageForChapterProgress(
        pageMap.chapters[0],
        restoreProgress.current
      );
    }
    boundary.current = null;
    applied.current = { chapterIndex: currentIndex, navigationKey };
    const nextLeaf = clamp(pageIndex + 1, 1, Math.max(1, leafCount));
    setLeaf(nextLeaf);
    updateLocation(nextLeaf);
  }, [
    laid,
    currentIndex,
    navigationKey,
    targetFragment,
    targetLocator,
    pageMap,
    textPages,
    sourceText,
    leafCount,
    updateLocation,
  ]);

  const moveChapter = useCallback(
    (direction: 1 | -1) => {
      const next = currentIndex + direction;
      if (next < 0 || next >= book.chapters.length) {
        return;
      }
      boundary.current = direction === 1 ? "next" : "previous";
      latest.current.onSelection("");
      latest.current.onReaderSelection?.(null);
      latest.current.onChapterChange(next);
    },
    [currentIndex, book.chapters.length]
  );

  const turnLeaf = useCallback(
    (direction: 1 | -1) => {
      if (turning || !laid) {
        return;
      }
      if (direction === -1 && atStart) {
        moveChapter(-1);
        return;
      }
      if (direction === 1 && atEnd) {
        moveChapter(1);
        return;
      }
      const next =
        direction === 1 && perView === 2 && leaf <= 1
          ? 3
          : leaf + direction * perView;
      if (direction === 1 && next > leafCount && hasNextChapter) {
        moveChapter(1);
        return;
      }
      setLeaf(clamp(next, 1, Math.max(1, leafCount)));
    },
    [
      turning,
      laid,
      atStart,
      atEnd,
      moveChapter,
      perView,
      leaf,
      hasNextChapter,
      leafCount,
    ]
  );
  useArrowTurns(turnLeaf);

  useEffect(() => {
    const element = stage.current;
    if (!element) {
      return;
    }
    const onClick = (event: Event) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      const href = anchor?.getAttribute("href");
      if (href) {
        event.preventDefault();
        event.stopPropagation();
        latest.current.onLink(href);
      }
    };
    const onSelection = () => {
      const selection = window.getSelection();
      if (
        !(
          selection &&
          !selection.isCollapsed &&
          element.contains(selection.anchorNode) &&
          element.contains(selection.focusNode)
        )
      ) {
        // A collapsed or outside selection hides the toolbar; the last
        // captured text stays available to the assistant until replaced.
        latest.current.onReaderSelection?.(null);
        return;
      }
      const located = locatorForSelection(
        selection,
        sourceText,
        laid?.chapter.id
      );
      latest.current.onSelection(selection.toString().trim().slice(0, 4000));
      latest.current.onReaderSelection?.(located);
    };
    element.addEventListener("click", onClick);
    document.addEventListener("selectionchange", onSelection);
    return () => {
      element.removeEventListener("click", onClick);
      document.removeEventListener("selectionchange", onSelection);
    };
  }, [sourceText, laid?.chapter.id]);

  useEffect(() => {
    const element = stage.current;
    if (typeof CSS === "undefined") {
      return;
    }
    const registry = (
      CSS as unknown as {
        highlights?: {
          set(name: string, value: unknown): void;
          delete(name: string): void;
        };
      }
    ).highlights;
    const HighlightClass = (
      window as unknown as {
        Highlight?: new (...ranges: Range[]) => unknown;
      }
    ).Highlight;
    if (!(element && registry && HighlightClass)) {
      return;
    }
    const update = () => {
      const ranges: Range[] = [];
      for (const note of validAnnotations) {
        for (const page of element.querySelectorAll(
          ".chapter-page[data-chapter-id]"
        )) {
          if (page.getAttribute("data-chapter-id") === note.locator.chapterId) {
            ranges.push(...rangesForLocator(page, note.locator));
          }
        }
      }
      if (ranges.length) {
        registry.set("leaflet-annotation", new HighlightClass(...ranges));
      } else {
        registry.delete("leaflet-annotation");
      }
    };
    const observer = new MutationObserver(update);
    observer.observe(element, { childList: true, subtree: true });
    update();
    return () => {
      observer.disconnect();
      registry.delete("leaflet-annotation");
    };
  }, [validAnnotations]);

  const leaves = useMemo<Leaf[]>(() => {
    const fallback = !supportsTextHighlights();
    return pageMap.pages.map((page, index) => {
      if (page.kind === "blank") {
        return { key: `blank-${index}`, kind: "blank", content: null };
      }
      if (page.kind === "end") {
        return {
          key: "end",
          kind: "end",
          content: (
            <div className="chapter-end">
              <span>The last leaf</span>
              <h2>{book.summary.title}</h2>
              <p>Turn back for a favorite passage, or choose another book.</p>
              <strong>Leaflet</strong>
            </div>
          ),
        };
      }
      const notes = validAnnotations.filter(
        (item) =>
          item.locator.chapterId === laid?.chapter.id &&
          (item.locator.start === item.locator.end
            ? item.locator.start >= page.page.startOffset &&
              (item.locator.start < page.page.endOffset ||
                index === textPages.length - 1)
            : item.locator.start < page.page.endOffset &&
              item.locator.end > page.page.startOffset)
      ).length;
      return {
        key: `text-${page.chapterIndex}-${index}`,
        kind: "text",
        content: (
          <div className="chapter-page" data-chapter-id={laid?.chapter.id}>
            <div
              className="chapter-page__copy"
              ref={graft(
                page.page.content,
                fallback
                  ? validAnnotations
                      .filter((item) => item.locator.start < item.locator.end)
                      .map((item) => item.locator)
                  : []
              )}
            />
            {notes > 0 && (
              <span
                aria-label={`${notes} notes`}
                className="chapter-page__notes"
                role="img"
              >
                ✦
              </span>
            )}
            <span className="chapter-page__number">{page.number}</span>
          </div>
        ),
      };
    });
  }, [pageMap, laid, textPages.length, validAnnotations, book.summary.title]);

  const canPrevious = !!laid && (leaf > 1 || hasPreviousChapter) && !turning;
  const canNext = !!laid && (!atEnd || hasNextChapter) && !turning;
  const pageStatus = laid
    ? `${single ? "Page" : "Leaf"} ${Math.min(leaf, meaningfulCount)} of ${meaningfulCount}`
    : "Finding your place…";
  const notices = [
    locatorWarning,
    invalidAnnotations.length
      ? `${invalidAnnotations.length} notes could not be placed in this chapter.`
      : null,
    assetWarning,
  ].filter((notice): notice is string => Boolean(notice));

  return (
    <section
      aria-label={`Paginated book: ${book.summary.title}`}
      className="chapter-book-stage"
      dir={
        chapter?.direction ??
        (book.summary.pageDirection === "right-to-left" ? "rtl" : "auto")
      }
      lang={chapter?.language ?? book.summary.language ?? undefined}
      ref={stage}
      style={
        {
          "--font-scale": fontScale,
          "--reader-page-height": `${size.height}px`,
        } as CSSProperties
      }
    >
      <div
        aria-hidden="true"
        className="chapter-paginator"
        style={{ width: size.width / perView, height: size.height }}
      >
        <div className="chapter-page">
          <div className="chapter-page__copy" ref={measurer} />
        </div>
      </div>

      <section
        aria-label={book.summary.title}
        className={cn(
          "curl-book curl-book--reading",
          single && "curl-book--single",
          !laid && "curl-book--waiting"
        )}
        ref={frame}
      >
        {laid ? (
          <TurnBook
            display={single ? "single" : "double"}
            height={size.height}
            leaves={leaves}
            onTurned={(page) => {
              setTurning(false);
              setLeaf(page);
              updateLocation(page);
            }}
            onTurning={() => setTurning(true)}
            page={leaf}
            width={size.width}
          />
        ) : (
          <div className="chapter-waiting">
            {loadError ? (
              <>
                <p>{loadError}</p>
                <Button
                  onClick={() => setRetry((value) => value + 1)}
                  variant="outline"
                >
                  <RotateCcw className="size-4" /> Try again
                </Button>
              </>
            ) : (
              <div role="status">
                <span aria-hidden="true" className="chapter-waiting__sparkle">
                  ✦
                </span>
                <p>
                  Opening {book.chapters[currentIndex]?.title ?? "chapter"}…
                </p>
              </div>
            )}
          </div>
        )}
      </section>

      <div className="book-controls">
        <Button
          aria-label={single ? "Previous page" : "Previous leaves"}
          disabled={!canPrevious}
          onClick={() => turnLeaf(-1)}
          size="icon"
          variant="ghost"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span aria-live="polite">{pageStatus}</span>
        <Button
          aria-label={single ? "Next page" : "Next leaves"}
          disabled={!canNext}
          onClick={() => turnLeaf(1)}
          size="icon"
          variant="ghost"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
      {notices.map((notice) => (
        <p className="chapter-locator-warning" key={notice} role="status">
          {notice}
        </p>
      ))}
    </section>
  );
}
