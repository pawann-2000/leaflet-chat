import { BookOpen, Trash2 } from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";
import { Button } from "@/components/motion/button";
import { Loader } from "@/components/motion/loader";
import type { LibraryBook } from "@/lib/types";
import { cn } from "@/lib/utils";

type Layout = "list" | "grid";

const opened = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

/** How long a first tap on "remove" stays armed before it reverts. */
const CONFIRM_WINDOW = 4000;

/**
 * Hues for generated covers. Picked from a curated ring so every book on the
 * shelf looks like it came from the same paper stock; the title hash chooses
 * one deterministically, so a book keeps its colour across devices.
 */
const COVER_HUES = [22, 40, 62, 92, 150, 200, 250, 300, 340];
const HASH_MODULUS = 4_294_967_296;
const PUNCTUATION = /[^\p{L}\p{N}\s]/gu;
const SPACES = /\s+/u;
const SMALL_WORDS = new Set(["a", "an", "the", "of", "and", "or", "to", "in"]);

export function coverHue(title: string): number {
  let hash = 5381;
  for (let index = 0; index < title.length; index += 1) {
    hash = (hash * 33 + title.charCodeAt(index)) % HASH_MODULUS;
  }
  return COVER_HUES[hash % COVER_HUES.length];
}

export function coverInitials(title: string): string {
  const words = title
    .replace(PUNCTUATION, " ")
    .split(SPACES)
    .filter((word) => word.length > 0 && !SMALL_WORDS.has(word.toLowerCase()));
  const picked = (words.length ? words : title.split(SPACES)).slice(0, 2);
  const initials = picked.map((word) => word.slice(0, 1)).join("");
  return (initials || "L").toLocaleUpperCase();
}

export function formatSize(bytes: number): string {
  if (bytes >= 1_048_576) {
    return `${(bytes / 1_048_576).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * A book cover. Real cover art when the EPUB declared one, otherwise a
 * typographic cover on coloured paper. The parent sets the width; the aspect
 * ratio and the type scale (`--cover-size`) follow from it.
 */
export function BookCover({
  book,
  className,
  showTitle = true,
  style,
}: {
  book: LibraryBook;
  className?: string;
  /** Print the title under the initials on generated covers (off for tiny sizes). */
  showTitle?: boolean;
  style?: CSSProperties;
}) {
  if (book.coverDataUrl) {
    return (
      <span className={cn("book-cover", className)} style={style}>
        <img
          alt=""
          decoding="async"
          height={222}
          loading="lazy"
          src={book.coverDataUrl}
          width={148}
        />
      </span>
    );
  }
  return (
    <span
      className={cn("book-cover book-cover--generated", className)}
      style={{ "--cover-hue": coverHue(book.title), ...style } as CSSProperties}
    >
      <span className="book-cover__initials">{coverInitials(book.title)}</span>
      {showTitle && (
        <>
          <span className="book-cover__rule" />
          <span className="book-cover__title">{book.title}</span>
        </>
      )}
    </span>
  );
}

/**
 * Removal is a two-tap action instead of a modal: the first tap arms the
 * button and relabels it, the second within a few seconds removes.
 */
export function RemoveBookButton({
  book,
  className,
  disabled,
  onRemove,
}: {
  book: LibraryBook;
  className?: string;
  disabled?: boolean;
  onRemove: (book: LibraryBook) => void;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) {
      return;
    }
    const timer = setTimeout(() => setArmed(false), CONFIRM_WINDOW);
    return () => clearTimeout(timer);
  }, [armed]);

  function remove() {
    if (armed) {
      setArmed(false);
      onRemove(book);
      return;
    }
    setArmed(true);
  }

  return (
    <Button
      aria-label={
        armed
          ? `Confirm removing “${book.title}” from this device`
          : `Remove “${book.title}” from this device`
      }
      className={cn(
        "shrink-0 text-muted-foreground hover:text-foreground",
        armed &&
          "bg-destructive text-white hover:bg-destructive hover:text-white",
        className
      )}
      data-armed={armed ? "true" : undefined}
      disabled={disabled}
      onBlur={() => setArmed(false)}
      onClick={remove}
      size={armed ? "sm" : "icon"}
      variant="ghost"
    >
      <Trash2 className="size-4" />
      {armed && "Remove?"}
    </Button>
  );
}

function ListItem({
  active,
  book,
  busy,
  onOpen,
  onRemove,
}: {
  active: boolean;
  book: LibraryBook;
  busy: boolean;
  onOpen: (id: string) => void;
  onRemove: (book: LibraryBook) => void;
}) {
  return (
    <li className="shelf-list__item" data-active={active ? "true" : undefined}>
      <button
        aria-current={active ? "true" : undefined}
        className="shelf-list__button"
        disabled={busy}
        onClick={() => onOpen(book.id)}
        type="button"
      >
        <BookCover book={book} showTitle={false} />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 font-medium font-serif text-sm leading-tight">
            {book.title}
          </span>
          <span className="line-clamp-1 text-muted-foreground text-xs">
            {book.authors.join(", ") || "Unknown author"}
          </span>
          <span className="eyebrow mt-0.5 block text-[10px] tracking-[0.12em]">
            {book.chapterCount} ch · {formatSize(book.size)} ·{" "}
            {opened.format(new Date(book.lastOpenedAt))}
          </span>
        </span>
      </button>
      {active ? (
        <BookOpen className="size-4 shrink-0 text-coral" />
      ) : (
        <RemoveBookButton
          book={book}
          className="opacity-60 hover:opacity-100"
          disabled={busy}
          onRemove={onRemove}
        />
      )}
    </li>
  );
}

function GridItem({
  active,
  book,
  busy,
  onOpen,
  onRemove,
}: {
  active: boolean;
  book: LibraryBook;
  busy: boolean;
  onOpen: (id: string) => void;
  onRemove: (book: LibraryBook) => void;
}) {
  return (
    <li className="book-card">
      <button
        aria-current={active ? "true" : undefined}
        className="book-card__button"
        disabled={busy}
        onClick={() => onOpen(book.id)}
        type="button"
      >
        <BookCover book={book} />
        <span className="book-card__title">{book.title}</span>
        <span className="book-card__author">
          {book.authors.join(", ") || "Unknown author"}
        </span>
      </button>
      <RemoveBookButton
        book={book}
        className="book-card__remove bg-card/90 shadow-paper"
        disabled={busy}
        onRemove={onRemove}
      />
    </li>
  );
}

/**
 * The on-device shelf as a plain list. Used by the sidebar (`list`) and as a
 * simple grid fallback; the homepage renders the richer shelves itself.
 */
export function LibraryShelf({
  books,
  busy,
  currentId,
  layout,
  onOpen,
  onRemove,
}: {
  books: LibraryBook[];
  busy: boolean;
  currentId: string | null;
  layout: Layout;
  onOpen: (id: string) => void;
  onRemove: (book: LibraryBook) => void;
}) {
  if (!books.length) {
    return busy ? (
      <div className="flex justify-center py-6">
        <Loader label="Loading the library" variant="dots" />
      </div>
    ) : null;
  }

  if (layout === "grid") {
    return (
      <ul
        aria-label="Library"
        className="grid w-full grid-cols-[repeat(auto-fill,minmax(9.25rem,1fr))] gap-5"
      >
        {books.map((book) => (
          <GridItem
            active={book.id === currentId}
            book={book}
            busy={busy}
            key={book.id}
            onOpen={onOpen}
            onRemove={onRemove}
          />
        ))}
      </ul>
    );
  }

  return (
    <ul aria-label="Library" className="shelf-list">
      {books.map((book) => (
        <ListItem
          active={book.id === currentId}
          book={book}
          busy={busy}
          key={book.id}
          onOpen={onOpen}
          onRemove={onRemove}
        />
      ))}
    </ul>
  );
}
