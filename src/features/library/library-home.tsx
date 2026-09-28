import { Leaf, Play, Search, Send, Users } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { Loader } from "@/components/motion/loader";
import { BookStage } from "@/features/reader/book-stage";
import { EASE_OUT, SPRING_LAYOUT } from "@/lib/ease";
import { useHoverCapable } from "@/lib/hooks/use-hover-capable";
import type { LibraryBook } from "@/lib/types";
import { cn } from "@/lib/utils";
import { BookCover, RemoveBookButton } from "./library-shelf";

export interface LibraryProgress {
  chapterIndex: number;
  lastReadAt: number;
  /** 0..100 across the whole book, e.g. `(chapterIndex + progress) / chapterCount * 100`. */
  percent: number;
  progress: number;
}

export interface LibraryHomeProps {
  books: LibraryBook[];
  busy: boolean;
  /** Most recently opened book, shown as the big "Continue reading" card. */
  continueId: string | null;
  onImport(): void;
  /** Present on the web host: opens the "Read together" join flow. */
  onJoin?(): void;
  onOpen(id: string): void;
  onRemove(book: LibraryBook): void;
  /** Present on the web host: opens the device transfer drawer. */
  onSync?(): void;
  /** Keyed by book id; may be missing for books that were never opened. */
  progress: Record<string, LibraryProgress>;
  /** Rendered beside the greeting: the reading streak / goal card. */
  stats?: ReactNode;
}

/** A book is "finished" from here on; below `STARTED` it still counts as unread. */
const FINISHED = 95;
const STARTED = 1;
const ROTATE_MS = 9000;

const TAGLINES = [
  "Every page you turn stays on this device.",
  "A few minutes a day adds up to a shelf.",
  "Highlights and notes travel with your books.",
  "Share a room code and turn pages together.",
  "Night mode is dark paper, not a black hole.",
];

const dayFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

function greeting(hour: number): string {
  if (hour < 5) {
    return "Reading late";
  }
  if (hour < 12) {
    return "Good morning";
  }
  if (hour < 17) {
    return "Good afternoon";
  }
  if (hour < 22) {
    return "Good evening";
  }
  return "Reading late";
}

function relativeDay(timestamp: number, now = Date.now()): string {
  const day = 86_400_000;
  const start = new Date(now).setHours(0, 0, 0, 0);
  if (timestamp >= start) {
    return "today";
  }
  if (timestamp >= start - day) {
    return "yesterday";
  }
  return `on ${dayFormat.format(new Date(timestamp))}`;
}

function percentOf(
  progress: Record<string, LibraryProgress>,
  book: LibraryBook
): number {
  const entry = progress[book.id];
  if (!(entry && Number.isFinite(entry.percent))) {
    return 0;
  }
  return Math.min(100, Math.max(0, entry.percent));
}

function Tagline() {
  const reduce = useReducedMotion();
  const [index, setIndex] = useState(
    () => Math.floor(Date.now() / ROTATE_MS) % TAGLINES.length
  );

  useEffect(() => {
    const timer = setInterval(
      () => setIndex((current) => (current + 1) % TAGLINES.length),
      ROTATE_MS
    );
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="library__tagline">
      <AnimatePresence initial={false} mode="wait">
        <motion.p
          animate={{ opacity: 1, y: 0 }}
          className="m-0"
          exit={reduce ? undefined : { opacity: 0, y: -6 }}
          initial={reduce ? false : { opacity: 0, y: 6 }}
          key={index}
          transition={{ duration: 0.32, ease: EASE_OUT }}
        >
          {TAGLINES[index]}
        </motion.p>
      </AnimatePresence>
    </div>
  );
}

function Ribbon({ percent, label }: { percent: number; label: string }) {
  const done = percent >= FINISHED;
  return (
    <span
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round(percent)}
      className={cn("ribbon", done && "ribbon--done")}
      role="progressbar"
    >
      <span
        className="ribbon__fill"
        style={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
      />
    </span>
  );
}

function ContinueCard({
  book,
  entry,
  onOpen,
  onJoin,
}: {
  book: LibraryBook;
  entry: LibraryProgress | undefined;
  onOpen: (id: string) => void;
  onJoin?: () => void;
}) {
  const percent = entry ? Math.min(100, Math.max(0, entry.percent)) : 0;
  const started = percent >= STARTED;
  const chapter = entry
    ? Math.min(entry.chapterIndex + 1, book.chapterCount)
    : 1;
  return (
    <section
      aria-labelledby="continue-title"
      className="continue-card paper animate-rise"
    >
      <BookCover book={book} />
      <div className="min-w-0">
        <p className="eyebrow">
          {started ? "Continue reading" : "Start reading"}
        </p>
        <h2 className="continue-card__title" id="continue-title">
          {book.title}
        </h2>
        <p className="continue-card__author">
          {book.authors.join(", ") || "Unknown author"}
        </p>
        <div className="continue-card__meta">
          <span className="continue-card__percent">{Math.round(percent)}%</span>
          <span>
            Chapter {chapter} of {book.chapterCount}
            {entry && ` · last read ${relativeDay(entry.lastReadAt)}`}
          </span>
        </div>
        <Ribbon label={`${Math.round(percent)}% read`} percent={percent} />
        <div className="continue-card__actions">
          <Button
            className="bg-coral text-coral-foreground hover:bg-coral/90"
            onClick={() => onOpen(book.id)}
            size="lg"
          >
            <Play className="size-4" />
            {started ? "Resume" : "Open the book"}
          </Button>
          {onJoin && (
            <Button onClick={onJoin} size="md" variant="ghost">
              <Users className="size-4" />
              Read together
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

function BookCard({
  book,
  busy,
  percent,
  onOpen,
  onRemove,
}: {
  book: LibraryBook;
  busy: boolean;
  percent: number;
  onOpen: (id: string) => void;
  onRemove: (book: LibraryBook) => void;
}) {
  const reduce = useReducedMotion();
  const canHover = useHoverCapable();
  const lift = reduce || !canHover ? undefined : { y: -8, rotate: -1.4 };
  return (
    <motion.li
      className="book-card"
      transition={SPRING_LAYOUT}
      whileHover={lift}
    >
      <button
        className="book-card__button"
        disabled={busy}
        onClick={() => onOpen(book.id)}
        type="button"
      >
        <span className="relative block">
          <BookCover book={book} />
          {percent >= STARTED && (
            <span className="book-card__ribbon">
              <Ribbon
                label={`${Math.round(percent)}% read`}
                percent={percent}
              />
            </span>
          )}
        </span>
        <span className="book-card__title">{book.title}</span>
        <span className="book-card__author">
          {book.authors.join(", ") || "Unknown author"}
        </span>
      </button>
      <span aria-hidden="true" className="book-card__shadow" />
      <RemoveBookButton
        book={book}
        className="book-card__remove bg-card/90 shadow-paper"
        disabled={busy}
        onRemove={onRemove}
      />
    </motion.li>
  );
}

function AddCard({ onImport }: { onImport: () => void }) {
  return (
    <li>
      <button className="add-card" onClick={onImport} type="button">
        <span className="add-card__leaf animate-float">
          <Leaf className="size-5" />
        </span>
        <strong>Add a book</strong>
        <span>Drop an EPUB anywhere, or choose one</span>
      </button>
    </li>
  );
}

function Shelf({
  books,
  busy,
  eyebrow,
  progress,
  title,
  onImport,
  onOpen,
  onRemove,
}: {
  books: LibraryBook[];
  busy: boolean;
  eyebrow: string;
  progress: Record<string, LibraryProgress>;
  title: string;
  onImport: () => void;
  onOpen: (id: string) => void;
  onRemove: (book: LibraryBook) => void;
}) {
  return (
    <section aria-label={title} className="shelf">
      <header className="shelf__head">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2 className="shelf__title">{title}</h2>
        </div>
        <span className="shelf__count">
          {books.length} {books.length === 1 ? "book" : "books"}
        </span>
      </header>
      <div className="shelf__board">
        <ul className="shelf__row">
          {books.map((book) => (
            <BookCard
              book={book}
              busy={busy}
              key={book.id}
              onOpen={onOpen}
              onRemove={onRemove}
              percent={percentOf(progress, book)}
            />
          ))}
          <AddCard onImport={onImport} />
        </ul>
      </div>
    </section>
  );
}

interface Shelves {
  finished: LibraryBook[];
  readingNow: LibraryBook[];
  upNext: LibraryBook[];
}

function groupBooks(
  books: LibraryBook[],
  progress: Record<string, LibraryProgress>
): Shelves {
  const shelves: Shelves = { readingNow: [], upNext: [], finished: [] };
  for (const book of books) {
    const percent = percentOf(progress, book);
    if (percent >= FINISHED) {
      shelves.finished.push(book);
    } else if (percent >= STARTED) {
      shelves.readingNow.push(book);
    } else {
      shelves.upNext.push(book);
    }
  }
  const lastRead = (book: LibraryBook) =>
    progress[book.id]?.lastReadAt ?? book.lastOpenedAt;
  shelves.readingNow.sort((a, b) => lastRead(b) - lastRead(a));
  shelves.finished.sort((a, b) => lastRead(b) - lastRead(a));
  shelves.upNext.sort((a, b) => b.addedAt - a.addedAt);
  return shelves;
}

function matches(book: LibraryBook, needle: string): boolean {
  return (
    book.title.toLocaleLowerCase().includes(needle) ||
    book.authors.some((author) => author.toLocaleLowerCase().includes(needle))
  );
}

function FooterStrip({
  onJoin,
  onSync,
}: {
  onJoin?: () => void;
  onSync?: () => void;
}) {
  return (
    <footer className="library__footer paper">
      <span>Your books stay in this browser. Nothing is uploaded.</span>
      {(onSync || onJoin) && (
        <div className="library__footer-actions">
          {onSync && (
            <Button onClick={onSync} size="sm" variant="ghost">
              <Send className="size-4" />
              Transfer to another device
            </Button>
          )}
          {onJoin && (
            <Button onClick={onJoin} size="sm" variant="ghost">
              <Users className="size-4" />
              Join a reading room
            </Button>
          )}
        </div>
      )}
    </footer>
  );
}

export function LibraryHome({
  books,
  busy,
  progress,
  stats,
  continueId,
  onOpen,
  onRemove,
  onImport,
  onJoin,
  onSync,
}: LibraryHomeProps) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase();
  const shelves = useMemo(() => groupBooks(books, progress), [books, progress]);
  const results = useMemo(
    () => (needle ? books.filter((book) => matches(book, needle)) : []),
    [books, needle]
  );
  const continueBook =
    continueId === null
      ? undefined
      : books.find((book) => book.id === continueId);

  if (!books.length) {
    if (busy) {
      return (
        <div className="flex h-full items-center justify-center">
          <Loader label="Loading the library" variant="dots" />
        </div>
      );
    }
    return (
      <BookStage
        library={books}
        libraryBusy={busy}
        onImport={onImport}
        onOpenBook={onOpen}
        onRemoveBook={onRemove}
      />
    );
  }

  const shelfProps = { busy, progress, onImport, onOpen, onRemove };
  const hour = new Date().getHours();

  return (
    <div className="library">
      <header className="library__hero">
        <div className="min-w-0">
          <p className="eyebrow">Your library · {books.length} books</p>
          <h1>
            {greeting(hour)}.
            <br />
            {continueBook && percentOf(progress, continueBook) >= STARTED
              ? "Pick up where you left off."
              : "What shall we read?"}
          </h1>
          <Tagline />
        </div>
        {stats && <div className="library__stats">{stats}</div>}
      </header>

      {continueBook && !needle && (
        <ContinueCard
          book={continueBook}
          entry={progress[continueBook.id]}
          onJoin={onJoin}
          onOpen={onOpen}
        />
      )}

      <div className="library__toolbar">
        <Input
          aria-label="Search your books"
          className="library__search"
          leftIcon={<Search className="size-4" />}
          onChange={setQuery}
          placeholder="Find a title or author"
          type="search"
          value={query}
        />
        <Button onClick={onImport} size="sm" variant="outline">
          <Leaf className="size-4" />
          Add an EPUB
        </Button>
      </div>

      {needle && results.length === 0 && (
        <p className="paper rounded-2xl px-5 py-8 text-center text-muted-foreground text-sm">
          No book matches “{query.trim()}”.
        </p>
      )}
      {needle && results.length > 0 && (
        <Shelf
          {...shelfProps}
          books={results}
          eyebrow="Search"
          title={`Results for “${query.trim()}”`}
        />
      )}
      {!needle && shelves.readingNow.length > 0 && (
        <Shelf
          {...shelfProps}
          books={shelves.readingNow}
          eyebrow="Bookmarks in"
          title="Reading now"
        />
      )}
      {!needle && shelves.upNext.length > 0 && (
        <Shelf
          {...shelfProps}
          books={shelves.upNext}
          eyebrow="Waiting on the shelf"
          title="Up next"
        />
      )}
      {!needle && shelves.finished.length > 0 && (
        <Shelf
          {...shelfProps}
          books={shelves.finished}
          eyebrow="Well done"
          title="Finished"
        />
      )}

      <FooterStrip onJoin={onJoin} onSync={onSync} />
    </div>
  );
}
