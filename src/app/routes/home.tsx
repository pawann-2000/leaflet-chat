import {
  Bookmark,
  FolderOpen,
  Library,
  MessageSquareText,
  MonitorSmartphone,
  Moon,
  NotebookPen,
  ShieldCheck,
  Type,
  Users,
  Zap,
} from "lucide-react";
import {
  type CSSProperties,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useExternalLinks } from "@/app/hooks/use-external-links";
import { useLeafletStore } from "@/app/hooks/use-leaflet-store";
import { useLibrary } from "@/app/hooks/use-library";
import { useReadingSession } from "@/app/hooks/use-reading-session";
import { takePendingRoomCode } from "@/app/routes/join";
import {
  AnimatedSidebarInset,
  AnimatedSidebarProvider,
} from "@/components/motion/animated-sidebar";
import {
  AnimatedToastStack,
  useAnimatedToastStack,
} from "@/components/motion/animated-toast-stack";
import {
  type CommandItem,
  CommandPalette,
} from "@/components/motion/command-palette";
import { Loader } from "@/components/motion/loader";
import { LibraryHome } from "@/features/library/library-home";
import {
  LibrarySidebar,
  type SidebarTab,
} from "@/features/library/library-sidebar";
import { ExternalLinkModal } from "@/features/links/external-link-modal";
import { TrustedSitesDrawer } from "@/features/links/trusted-sites-drawer";
import { ReaderFooter, ReaderHeader } from "@/features/reader/reader-chrome";
import {
  type SelectionAction,
  SelectionToolbar,
} from "@/features/reader/selection-toolbar";
import { GoalCelebration } from "@/features/reading/celebration";
import { NotesPanel } from "@/features/reading/notes-panel";
import { ReadingTimerChip } from "@/features/reading/reading-chip";
import { storedRelayUrl } from "@/features/reading/room-settings";
import { StreakCard } from "@/features/reading/streak-card";
import { errorMessage } from "@/lib/errors";
import { isDesktopHost, platform } from "@/lib/platform";
import { useReadingPrefs } from "@/lib/prefs";
import type { ContentLocator, ReaderSelection } from "@/lib/reader/locator";
import {
  useReadingOverview,
  useReadingTracker,
  useSpeedReadingPrefs,
} from "@/lib/reading/hooks";
import { normalizeRoomCode } from "@/lib/rooms";
import { onServiceWorkerUpdate } from "@/lib/sw/register";
import type {
  Chapter,
  OpenedBook,
  OpenedPublication,
  TocEntry,
} from "@/lib/types";

const PublicationBook = lazy(() =>
  import("@/features/reader/publication-book").then((module) => ({
    default: module.PublicationBook,
  }))
);
const SyncDrawer = lazy(() =>
  import("@/features/sync/sync-drawer").then((module) => ({
    default: module.SyncDrawer,
  }))
);
const TogetherDrawer = lazy(() =>
  import("@/features/reading/together-drawer").then((module) => ({
    default: module.TogetherDrawer,
  }))
);
const SpeedReader = lazy(() =>
  import("@/features/reading/speed-reader").then((module) => ({
    default: module.SpeedReader,
  }))
);

const SIDEBAR_STYLE = {
  "--sidebar-width": "22rem",
  "--sidebar-width-icon": "3.75rem",
  "--sidebar-width-mobile": "min(22rem, 88vw)",
} as CSSProperties;
const INTERNAL_TOKEN = "#leaflet-link-internal-";
const READER_ID_KEY = "leaflet.reader-id";

interface ChapterLayout {
  chapterId: string;
  pages: number;
  sourceText: string;
}

function readerId(): string | null {
  try {
    return localStorage.getItem(READER_ID_KEY);
  } catch {
    return null;
  }
}

function headerEyebrow(reading: boolean, roomCode: string | null): string {
  if (!reading) {
    return "Library";
  }
  return roomCode ? `Reading together · ${roomCode}` : "Reading";
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the route joins the library, reader, notes, rooms and reading-time flows into one screen.
export function HomePage() {
  const host = platform();
  const { library: hasLibrary, sync: hasSync } = host.capabilities;
  const prefs = useReadingPrefs();
  const { toasts, showToast, dismissToast } = useAnimatedToastStack({
    limit: 3,
  });
  const fail = useCallback(
    (error: unknown) =>
      showToast({ title: errorMessage(error), status: "error" }),
    [showToast]
  );
  const store = useLeafletStore(fail);

  // Reader state.
  const [book, setBook] = useState<OpenedBook | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [supplementary, setSupplementary] = useState<Chapter | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [initialProgress, setInitialProgress] = useState(0);
  const [targetFragment, setTargetFragment] = useState<string | null>(null);
  const [targetLocator, setTargetLocator] = useState<ContentLocator | null>(
    null
  );
  const [navigationKey, setNavigationKey] = useState(0);
  const [selectedText, setSelectedText] = useState("");
  const [readerSelection, setReaderSelection] =
    useState<ReaderSelection | null>(null);
  const [readingLocation, setReadingLocation] = useState<ContentLocator | null>(
    null
  );
  const [layout, setLayout] = useState<ChapterLayout | null>(null);
  const [composeSelection, setComposeSelection] =
    useState<ReaderSelection | null>(null);
  const [speed, setSpeed] = useState<{ startOffset: number } | null>(null);

  // Shell state.
  const [navOpen, setNavOpen] = useState(true);
  const [navMobileOpen, setNavMobileOpen] = useState(false);
  const [tab, setTab] = useState<SidebarTab>("contents");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [togetherOpen, setTogetherOpen] = useState(false);
  const [pendingRoomCode, setPendingRoomCode] = useState<string | null>(null);
  const [followingId, setFollowingId] = useState<string | null>(null);
  const [celebrate, setCelebrate] = useState(false);
  const [overviewKey, setOverviewKey] = useState(0);

  const stageRef = useRef<HTMLElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const readingLocationRef = useRef<ContentLocator | null>(null);
  const navigationKeyRef = useRef(navigationKey);
  navigationKeyRef.current = navigationKey;
  const followedLocation = useRef<string>("");

  const chapter =
    supplementary ??
    chapters.find((item) => item.index === currentIndex) ??
    null;
  const chapterCount = book?.chapters.length ?? 0;

  const displayedBook = useMemo<OpenedBook | null>(
    () =>
      book && supplementary
        ? {
            ...book,
            chapters: [
              { id: supplementary.id, index: 0, title: supplementary.title },
            ],
            summary: { ...book.summary, chapterCount: 1 },
          }
        : book,
    [book, supplementary]
  );
  const displayedChapters = useMemo(
    () => (supplementary ? [{ ...supplementary, index: 0 }] : chapters),
    [chapters, supplementary]
  );

  // ---------------------------------------------------------------------
  // Opening books

  const commitPublication = useCallback(
    async (publication: OpenedPublication) => {
      const id = publication.book.summary.id;
      let position = { chapterIndex: 0, progress: 0 };
      if (host.loadProgress) {
        try {
          const saved = await host.loadProgress(id);
          if (
            saved &&
            saved.chapterIndex >= 0 &&
            saved.chapterIndex < publication.book.chapters.length
          ) {
            position = saved;
          }
        } catch (error) {
          fail(error);
        }
      }
      setBook((current) => {
        if (current && current.summary.id !== id) {
          host.closeBook?.(current.summary.id).catch(() => undefined);
        }
        return publication.book;
      });
      setChapters(publication.chapters);
      setSupplementary(null);
      setCurrentIndex(position.chapterIndex);
      setInitialProgress(position.progress);
      setTargetFragment(null);
      setTargetLocator(null);
      setSelectedText("");
      setReaderSelection(null);
      setComposeSelection(null);
      setReadingLocation(null);
      setLayout(null);
      setFollowingId(null);
      readingLocationRef.current = null;
      setNavigationKey((key) => key + 1);
      setTab("contents");
      setNavMobileOpen(false);
      showToast({
        title: `Opened “${publication.book.summary.title}”`,
        status: "success",
      });
    },
    [host, fail, showToast]
  );

  const onRemovedFromShelf = useCallback((id: string) => {
    setBook((current) => (current?.summary.id === id ? null : current));
  }, []);

  const library = useLibrary(host, commitPublication, fail, onRemovedFromShelf);
  const refreshLibrary = library.refresh;

  const external = useExternalLinks(host, fail);

  const { session, sessionRef, revision } = useReadingSession(book, {
    onError: fail,
    onRestore: (saved) => {
      if (!book) {
        return;
      }
      const index = book.chapters.findIndex(
        (item) => item.id === saved.chapterId
      );
      if (index >= 0) {
        setSupplementary(null);
        setCurrentIndex(index);
        setTargetLocator(saved);
        setNavigationKey((key) => key + 1);
        return;
      }
      const document = book.documents.find(
        (item) => item.id === saved.chapterId
      );
      if (!document) {
        return;
      }
      const startingNavigation = navigationKeyRef.current;
      host
        .resolveBookLink(book.summary.id, document.link)
        .then((target) => {
          if (
            target.kind !== "internal" ||
            navigationKeyRef.current !== startingNavigation
          ) {
            return;
          }
          setSupplementary(target.chapter);
          setTargetLocator(saved);
          setNavigationKey((key) => key + 1);
        })
        .catch(fail);
    },
    currentLocation: () => readingLocationRef.current,
    navigationKey: () => navigationKeyRef.current,
  });
  const room = session?.room ?? null;
  const canAnnotate = Boolean(session?.canAnnotate);

  // Reading time, goal and speed-reading preferences.
  const tracker = useReadingTracker(store, book?.summary.id ?? null);
  const overview = useReadingOverview(store, overviewKey);
  const speedPrefs = useSpeedReadingPrefs(store);
  const { goalJustMet, acknowledgeGoal } = tracker;
  useEffect(() => {
    if (goalJustMet) {
      setCelebrate(true);
      acknowledgeGoal();
    }
  }, [goalJustMet, acknowledgeGoal]);

  // ---------------------------------------------------------------------
  // Startup: notices, library, shared files, desktop diagnostics, join links

  const started = useRef(false);
  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    if (host.startupNotice) {
      showToast({ title: host.startupNotice, status: "info" });
    }
    refreshLibrary();
    const pending = takePendingRoomCode();
    if (pending !== null) {
      setPendingRoomCode(pending);
    }
    const stopUpdates = onServiceWorkerUpdate(() =>
      showToast({
        title: "A new version of Leaflet is ready.",
        status: "info",
        duration: 15_000,
        action: { label: "Reload", onClick: () => window.location.reload() },
      })
    );
    if (isDesktopHost) {
      // Desktop link-navigation harness: opens a fixture chosen by the Rust side.
      import("@/lib/platform/tauri").then(
        ({ diagnosticLinkConfig, openBookPath }) =>
          diagnosticLinkConfig().then(async (diagnostic) => {
            if (!diagnostic) {
              return;
            }
            try {
              (
                window as typeof window & {
                  __LEAFLET_DIAGNOSTIC_LINK_INDEX__?: number;
                }
              ).__LEAFLET_DIAGNOSTIC_LINK_INDEX__ = diagnostic.linkIndex;
              await commitPublication(await openBookPath(diagnostic.path));
            } catch (error) {
              fail(error);
            }
          })
      );
    }
    return stopUpdates;
  }, [host.startupNotice, showToast, refreshLibrary, commitPublication, fail]);

  // A `/join#CODE` link: find the matching book on the shelf and open it, then
  // the drawer joins as soon as the session exists.
  const resolvingJoin = useRef(false);
  useEffect(() => {
    if (
      pendingRoomCode === null ||
      resolvingJoin.current ||
      library.busy ||
      book
    ) {
      return;
    }
    const code = normalizeRoomCode(pendingRoomCode);
    if (!code) {
      if (pendingRoomCode !== "") {
        showToast({
          title: "That invitation link is not a Leaflet room code.",
          status: "error",
        });
      }
      setPendingRoomCode(null);
      setTogetherOpen(true);
      return;
    }
    resolvingJoin.current = true;
    import("@/lib/reading-sync")
      .then(({ peekRoom }) => peekRoom(code, storedRelayUrl()))
      .then(async (peek) => {
        const match = library.books.find(
          (item) => item.id === peek.fingerprint
        );
        if (match) {
          showToast({
            title: `Joining ${peek.hostName}'s room for “${peek.bookTitle}”…`,
            status: "info",
          });
          await library.openFromShelf(match.id);
        } else {
          showToast({
            title: `Add “${peek.bookTitle}” (the same EPUB file) to join ${peek.hostName}'s room.`,
            status: "info",
            duration: 12_000,
          });
        }
        setTogetherOpen(true);
      })
      .catch((error: unknown) => {
        fail(error);
        setTogetherOpen(true);
      })
      .finally(() => {
        resolvingJoin.current = false;
      });
  }, [
    pendingRoomCode,
    library.busy,
    library.books,
    library.openFromShelf,
    book,
    fail,
    showToast,
  ]);

  useEffect(() => {
    if (!book) {
      setOverviewKey((key) => key + 1);
    }
  }, [book]);

  // ---------------------------------------------------------------------
  // Navigation

  function openPanel(next: SidebarTab) {
    setTab(next);
    setNavOpen(true);
    setNavMobileOpen(true);
  }

  function openChapter(index: number, fragment: string | null = null) {
    if (
      !(book && Number.isInteger(index)) ||
      index < 0 ||
      index >= chapterCount
    ) {
      return;
    }
    setSelectedText("");
    setReaderSelection(null);
    setTargetLocator(null);
    setSupplementary(null);
    setCurrentIndex(index);
    setTargetFragment(fragment);
    setNavigationKey((key) => key + 1);
  }

  function followPageTurn(index: number) {
    if (supplementary || index < 0 || index >= chapterCount) {
      return;
    }
    setCurrentIndex(index);
    setTargetFragment(null);
    setReaderSelection(null);
    setTargetLocator(null);
  }

  function onReaderLocation(locator: ContentLocator) {
    setReadingLocation(locator);
    readingLocationRef.current = locator;
    tracker.activity();
    try {
      sessionRef.current?.saveLocation(locator);
    } catch (error) {
      fail(error);
    }
  }

  const navigateLocator = useCallback(
    async (locator: ContentLocator) => {
      if (!book) {
        return;
      }
      const index = book.chapters.findIndex(
        (item) => item.id === locator.chapterId
      );
      if (index < 0) {
        const document = book.documents.find(
          (item) => item.id === locator.chapterId
        );
        if (!document) {
          showToast({
            title: "This passage is not available in this book.",
            status: "error",
          });
          return;
        }
        try {
          const target = await host.resolveBookLink(
            book.summary.id,
            document.link
          );
          if (target.kind !== "internal") {
            throw new Error("This saved passage is not a book section.");
          }
          setSupplementary(target.chapter);
        } catch (error) {
          fail(error);
          return;
        }
      } else {
        setSupplementary(null);
        setCurrentIndex(index);
      }
      setReaderSelection(null);
      setTargetFragment(null);
      setTargetLocator(locator);
      setNavigationKey((key) => key + 1);
    },
    [book, host, fail, showToast]
  );

  // Follow a room member: turn to wherever they are whenever they move.
  useEffect(() => {
    if (!(followingId && room)) {
      return;
    }
    const member = room.members.find((item) => item.id === followingId);
    if (!member) {
      setFollowingId(null);
      return;
    }
    const location = member.location;
    if (!location) {
      return;
    }
    const key = JSON.stringify(location);
    if (followedLocation.current === key) {
      return;
    }
    followedLocation.current = key;
    navigateLocator(location).catch(fail);
  }, [followingId, room, navigateLocator, fail]);

  function chapterLoaded(loaded: Chapter) {
    if (supplementary) {
      return;
    }
    setChapters((current) => {
      if (
        current.some(
          (item) => item.id === loaded.id && item.index === loaded.index
        )
      ) {
        return current;
      }
      return [
        ...current.filter((item) => item.index !== loaded.index),
        loaded,
      ].sort((a, b) => a.index - b.index);
    });
  }

  function recordProgress(chapterIndex: number, progress: number) {
    if (!book) {
      return;
    }
    const bookId = book.summary.id;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(
      () => host.saveProgress(bookId, chapterIndex, progress).catch(fail),
      500
    );
  }

  async function handleBookLink(href: string) {
    if (!book) {
      return;
    }
    if (href.startsWith("#") && !href.startsWith("#leaflet-link-")) {
      setTargetFragment(href.slice(1));
      setNavigationKey((key) => key + 1);
      return;
    }
    try {
      const target = await host.resolveBookLink(book.summary.id, href);
      if (target.kind === "internal") {
        if (target.chapterIndex === null) {
          setSupplementary(target.chapter);
          setTargetFragment(target.fragment);
          setTargetLocator(null);
          setNavigationKey((key) => key + 1);
          return;
        }
        openChapter(target.chapterIndex, target.fragment);
        return;
      }
      if (href.startsWith(INTERNAL_TOKEN)) {
        showToast({
          title: "This link points inside the book but could not be opened.",
          status: "error",
        });
        return;
      }
      if (target.trusted) {
        await host.openExternalLink(target.requestId, "trusted");
      } else {
        external.setPending(target);
      }
    } catch (error) {
      fail(error);
    }
  }

  function backToLibrary() {
    if (book) {
      host.closeBook?.(book.summary.id).catch(() => undefined);
    }
    setBook(null);
    setChapters([]);
    setSupplementary(null);
    setLayout(null);
    setReaderSelection(null);
    setComposeSelection(null);
    setFollowingId(null);
    setTogetherOpen(false);
    refreshLibrary();
  }

  // ---------------------------------------------------------------------
  // Selection, notes, speed reading

  function bookmarkPage() {
    const current = sessionRef.current;
    const location = readingLocationRef.current;
    if (!(current && location)) {
      return;
    }
    try {
      current.add("bookmark", location);
      showToast({ title: "Page bookmarked", status: "success" });
    } catch (error) {
      fail(error);
    }
  }

  function openSpeedReader(startOffset?: number) {
    if (!layout) {
      showToast({
        title: "The chapter is still being laid out. One moment…",
        status: "info",
      });
      return;
    }
    window.getSelection()?.removeAllRanges();
    setSpeed({ startOffset: startOffset ?? readingLocation?.start ?? 0 });
  }

  async function onSelectionAction(
    action: SelectionAction,
    selection: ReaderSelection
  ) {
    tracker.activity();
    const clear = () => {
      window.getSelection()?.removeAllRanges();
      setReaderSelection(null);
    };
    switch (action) {
      case "highlight":
        try {
          sessionRef.current?.add("highlight", selection.locator);
          showToast({ title: "Highlighted", status: "success" });
          clear();
        } catch (error) {
          fail(error);
        }
        return;
      case "note":
        setComposeSelection(selection);
        openPanel("notes");
        return;
      case "copy":
        try {
          await navigator.clipboard.writeText(selection.text);
          showToast({ title: "Copied to the clipboard", status: "success" });
          clear();
        } catch {
          showToast({
            title: "Copying was blocked by the browser.",
            status: "error",
          });
        }
        return;
      case "ask":
        setSelectedText(selection.text);
        openPanel("ask");
        return;
      case "speed":
        openSpeedReader(selection.locator.start);
        return;
      default:
        return;
    }
  }

  // Reading activity keeps the timer alive; shortcuts while a book is open.
  // The handlers live in a ref so the listeners bind once per book.
  const shortcuts = useRef({
    activity: tracker.activity,
    speed: openSpeedReader,
    notes: () => openPanel("notes"),
    bookmark: bookmarkPage,
    together: () => setTogetherOpen(true),
    busy: () => Boolean(speed),
  });
  shortcuts.current = {
    activity: tracker.activity,
    speed: openSpeedReader,
    notes: () => openPanel("notes"),
    bookmark: bookmarkPage,
    together: () => setTogetherOpen(true),
    busy: () => Boolean(speed),
  };
  useEffect(() => {
    if (!book) {
      return;
    }
    const alive = () => shortcuts.current.activity();
    const onKey = (event: KeyboardEvent) => {
      alive();
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isTypingTarget(event.target) ||
        shortcuts.current.busy()
      ) {
        return;
      }
      const action = {
        s: shortcuts.current.speed,
        n: shortcuts.current.notes,
        b: shortcuts.current.bookmark,
        t: shortcuts.current.together,
      }[event.key];
      if (action) {
        event.preventDefault();
        action();
      }
    };
    document.addEventListener("pointerdown", alive, { passive: true });
    document.addEventListener("wheel", alive, { passive: true });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", alive);
      document.removeEventListener("wheel", alive);
      document.removeEventListener("keydown", onKey);
    };
  }, [book]);

  // ---------------------------------------------------------------------
  // Commands

  const commands: CommandItem[] = [
    {
      id: "import",
      label: hasLibrary ? "Add an EPUB" : "Import EPUB",
      group: "Library",
      icon: FolderOpen,
      onSelect: library.importBook,
    },
    ...(book
      ? [
          {
            id: "library",
            label: "Back to the library",
            group: "Library",
            icon: Library,
            onSelect: backToLibrary,
          },
          {
            id: "speed",
            label: "Speed read from here",
            group: "Reading",
            icon: Zap,
            hint: "S",
            onSelect: () => openSpeedReader(),
          },
          {
            id: "bookmark",
            label: "Bookmark this page",
            group: "Reading",
            icon: Bookmark,
            hint: "B",
            onSelect: bookmarkPage,
          },
          {
            id: "notes",
            label: "Notes and highlights",
            group: "Reading",
            icon: NotebookPen,
            hint: "N",
            onSelect: () => openPanel("notes"),
          },
          {
            id: "together",
            label: room ? "Reading room" : "Read together",
            group: "Reading",
            icon: Users,
            hint: "T",
            onSelect: () => setTogetherOpen(true),
          },
          {
            id: "ask",
            label: "Ask about this chapter",
            group: "Reading",
            icon: MessageSquareText,
            onSelect: () => openPanel("ask"),
          },
          {
            id: "next",
            label: "Next chapter",
            group: "Reading",
            hint: "→",
            onSelect: () => openChapter(currentIndex + 1),
          },
          {
            id: "previous",
            label: "Previous chapter",
            group: "Reading",
            hint: "←",
            onSelect: () => openChapter(currentIndex - 1),
          },
        ]
      : [
          {
            id: "join",
            label: "Join a reading room",
            group: "Library",
            icon: Users,
            onSelect: () => setTogetherOpen(true),
          },
        ]),
    {
      id: "larger",
      label: "Larger text",
      group: "Appearance",
      icon: Type,
      onSelect: () => prefs.stepFontScale(1),
    },
    {
      id: "smaller",
      label: "Smaller text",
      group: "Appearance",
      icon: Type,
      onSelect: () => prefs.stepFontScale(-1),
    },
    {
      id: "night",
      label: prefs.colorMode === "night" ? "Paper mode" : "Night mode",
      group: "Appearance",
      icon: Moon,
      onSelect: () => prefs.setNight(prefs.colorMode !== "night"),
    },
    ...(hasSync
      ? [
          {
            id: "sync",
            label: "Your devices",
            group: "Library",
            icon: MonitorSmartphone,
            onSelect: () => setSyncOpen(true),
          },
        ]
      : []),
    {
      id: "trusted",
      label: "Trusted sites",
      group: "Library",
      icon: ShieldCheck,
      onSelect: external.openTrusted,
    },
    ...library.books.map((item) => ({
      id: `book-${item.id}`,
      label: item.title,
      group: "Library books",
      keywords: item.authors,
      onSelect: () => library.openFromShelf(item.id),
    })),
    ...(book?.chapters ?? []).map((item) => ({
      id: `chapter-${item.id}`,
      label: item.title,
      group: "Chapters",
      hint: String(item.index + 1).padStart(2, "0"),
      onSelect: () => openChapter(item.index),
    })),
  ];

  const continueId = library.books[0]?.id ?? null;
  const navigateToc = (entry: TocEntry) =>
    handleBookLink(entry.link).catch(fail);

  const notesPanel = (
    <NotesPanel
      compose={composeSelection}
      location={readingLocation}
      onComposeDone={() => {
        setComposeSelection(null);
        window.getSelection()?.removeAllRanges();
        setReaderSelection(null);
      }}
      onError={(message) => showToast({ title: message, status: "error" })}
      onNavigate={(locator) => {
        navigateLocator(locator).catch(fail);
        setNavMobileOpen(false);
      }}
      onOpenTogether={() => setTogetherOpen(true)}
      readerId={readerId()}
      revision={revision}
      session={session}
    />
  );

  return (
    <>
      <AnimatedSidebarProvider
        className="h-svh"
        onOpenChange={setNavOpen}
        onOpenMobileChange={setNavMobileOpen}
        open={navOpen}
        openMobile={navMobileOpen}
        style={SIDEBAR_STYLE}
      >
        <LibrarySidebar
          book={book}
          chapter={chapter}
          currentIndex={supplementary ? -1 : currentIndex}
          library={library.books}
          libraryBusy={library.busy}
          notesPanel={notesPanel}
          onError={(message) => showToast({ title: message, status: "error" })}
          onImport={library.importBook}
          onNavigate={navigateToc}
          onOpenBook={library.openFromShelf}
          onRemoveBook={library.removeFromShelf}
          onSelect={openChapter}
          onSync={hasSync ? () => setSyncOpen(true) : undefined}
          onTabChange={setTab}
          onTrustedSites={external.openTrusted}
          selectedText={selectedText}
          tab={tab}
        />
        <AnimatedSidebarInset className="h-svh min-h-0 overflow-hidden">
          <ReaderHeader
            eyebrow={headerEyebrow(Boolean(book), room?.code ?? null)}
            onCommands={() => setPaletteOpen(true)}
            onLibrary={backToLibrary}
            onNotes={() => openPanel("notes")}
            onSpeedRead={() => openSpeedReader()}
            onTogether={() => setTogetherOpen(true)}
            prefs={prefs}
            reading={Boolean(book)}
            roomCount={room ? room.members.length : 0}
            timer={
              book ? (
                <ReadingTimerChip
                  active={tracker.snapshot.active}
                  goalMet={tracker.snapshot.goalMet}
                  seconds={tracker.snapshot.elapsed}
                />
              ) : undefined
            }
            title={chapter?.title ?? book?.summary.title ?? "Leaflet"}
          />

          <div className="reader relative min-h-0 flex-1 overflow-hidden">
            {book ? (
              <Suspense
                fallback={
                  <div className="grid h-full place-items-center">
                    <Loader label="Opening the reader" variant="dots" />
                  </div>
                }
              >
                <PublicationBook
                  annotations={session?.annotations ?? []}
                  book={displayedBook ?? book}
                  chapters={displayedChapters}
                  currentIndex={supplementary ? 0 : currentIndex}
                  fontScale={prefs.fontScale}
                  initialProgress={initialProgress}
                  key={`${book.summary.id}:${supplementary?.id ?? "spine"}`}
                  loadChapter={(index) =>
                    supplementary
                      ? Promise.resolve({ ...supplementary, index: 0 })
                      : host.loadChapter(book.summary.id, index)
                  }
                  navigationKey={navigationKey}
                  onChapterChange={followPageTurn}
                  onChapterLoaded={chapterLoaded}
                  onLaidOut={setLayout}
                  onLink={handleBookLink}
                  onLocation={onReaderLocation}
                  onLocatorError={(_locator, reason) =>
                    showToast({ title: reason, status: "error" })
                  }
                  onPageShown={(words) => tracker.pageTurned(words)}
                  onProgress={supplementary ? () => undefined : recordProgress}
                  onReaderSelection={setReaderSelection}
                  onSelection={setSelectedText}
                  stageRef={stageRef}
                  targetFragment={targetFragment}
                  targetLocator={targetLocator}
                />
              </Suspense>
            ) : (
              !library.loading && (
                <div className="scrollbar-paper flex h-full flex-col overflow-y-auto">
                  <LibraryHome
                    books={library.books}
                    busy={library.busy}
                    continueId={continueId}
                    onImport={library.importBook}
                    onJoin={() => setTogetherOpen(true)}
                    onOpen={library.openFromShelf}
                    onRemove={library.removeFromShelf}
                    onSync={hasSync ? () => setSyncOpen(true) : undefined}
                    progress={library.progress}
                    stats={
                      overview.overview ? (
                        <StreakCard
                          onGoalChange={overview.setGoal}
                          overview={overview.overview}
                        />
                      ) : undefined
                    }
                  />
                </div>
              )
            )}
            {library.dragging && (
              <div className="pointer-events-none absolute inset-3 z-20 grid place-items-center rounded-2xl border-2 border-coral border-dashed bg-background/85 font-serif text-lg">
                Drop the EPUB to add it to your shelf
              </div>
            )}
            {library.loading && (
              <div
                aria-live="polite"
                className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/70 backdrop-blur-sm"
              >
                <Loader label="Opening the book" variant="dots" />
                <p className="font-serif text-muted-foreground text-sm">
                  Opening the book…
                </p>
              </div>
            )}
          </div>

          {book && (
            <ReaderFooter
              chapterCount={chapterCount}
              chapterIndex={currentIndex}
              onAsk={() => openPanel("ask")}
              onBackToBook={() => openChapter(currentIndex)}
              onContents={() => openPanel("contents")}
              onNextChapter={() => openChapter(currentIndex + 1)}
              onNotes={() => openPanel("notes")}
              onPreviousChapter={() => openChapter(currentIndex - 1)}
              onSpeedRead={() => openSpeedReader()}
              prefs={prefs}
              supplementaryTitle={supplementary?.title ?? null}
            />
          )}
        </AnimatedSidebarInset>
      </AnimatedSidebarProvider>

      {book && (
        <SelectionToolbar
          canAnnotate={canAnnotate}
          onAction={(action, selection) => {
            onSelectionAction(action, selection).catch(fail);
          }}
          selection={speed ? null : readerSelection}
          stageRef={stageRef}
        />
      )}

      <ExternalLinkModal
        busy={external.busy}
        onCancel={() => external.setPending(null)}
        onOpen={external.confirm}
        target={external.pending}
      />
      <TrustedSitesDrawer
        busy={external.trustedBusy}
        onClose={external.closeTrusted}
        onRevoke={external.revoke}
        onRevokeAll={() => external.revoke(null)}
        open={external.trustedOpen}
        sites={external.trustedSites}
      />
      <Suspense fallback={null}>
        {hasSync && syncOpen && (
          <SyncDrawer
            onClose={() => setSyncOpen(false)}
            onError={(message) =>
              showToast({ title: message, status: "error" })
            }
            onSynced={refreshLibrary}
            open={syncOpen}
          />
        )}
        {togetherOpen && (
          <TogetherDrawer
            bookTitle={book?.summary.title ?? ""}
            followingId={followingId}
            initialCode={pendingRoomCode && normalizeRoomCode(pendingRoomCode)}
            key={book?.summary.fingerprint ?? "closed"}
            onClose={() => {
              setTogetherOpen(false);
              setPendingRoomCode(null);
            }}
            onError={(message) =>
              showToast({ title: message, status: "error" })
            }
            onFollow={(id) => {
              followedLocation.current = "";
              setFollowingId(id);
            }}
            onVisit={(locator) => navigateLocator(locator).catch(fail)}
            open={togetherOpen}
            revision={revision}
            session={session}
          />
        )}
        {speed && layout && (
          <SpeedReader
            chunk={speedPrefs.prefs.chunk}
            onActivity={tracker.activity}
            onChunkChange={speedPrefs.setChunk}
            onClose={(result) => {
              setSpeed(null);
              tracker.pageTurned(result.wordsRead);
              if (result.offset > speed.startOffset) {
                navigateLocator({
                  chapterId: layout.chapterId,
                  start: result.offset,
                  end: result.offset,
                  quote: "",
                }).catch(fail);
              }
            }}
            onWpmChange={speedPrefs.setWpm}
            open
            startOffset={speed.startOffset}
            text={layout.sourceText}
            title={chapter?.title ?? book?.summary.title ?? ""}
            wpm={speedPrefs.prefs.wpm}
          />
        )}
      </Suspense>
      <GoalCelebration onDone={() => setCelebrate(false)} show={celebrate} />
      <CommandPalette
        items={commands}
        onOpenChange={setPaletteOpen}
        open={paletteOpen}
        placeholder="Jump to a chapter or run a command…"
      />
      <AnimatedToastStack
        onDismiss={dismissToast}
        position="bottom-right"
        toasts={toasts}
      />
    </>
  );
}

export const Component = HomePage;
