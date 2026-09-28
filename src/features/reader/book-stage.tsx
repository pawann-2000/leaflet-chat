import {
  ArrowLeft,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Leaf,
  Users,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/motion/button";
import type { LibraryBook } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  type Leaf as BookLeaf,
  TurnBook,
  useArrowTurns,
  useElementSize,
  useMediaQuery,
} from "./turn-book";

const plate = (key: string, lead: string, trail: string): BookLeaf => ({
  key,
  kind: "plate",
  content: (
    <div className="book-plate">
      <span className="book-plate__lead">{lead}</span>
      <span className="book-plate__trail">{trail}</span>
    </div>
  ),
});

const quote = (
  label: string,
  title: string,
  text: string,
  author: string
): BookLeaf => ({
  key: label,
  kind: "quote",
  content: (
    <div className="book-page">
      <span className="book-page__label">{label}</span>
      <h3 className="book-page__title">{title}</h3>
      <blockquote className="book-page__quote">{text}</blockquote>
      <cite className="book-page__author">{author}</cite>
    </div>
  ),
});

const LEAVES: BookLeaf[] = [
  plate("cover", "Turn", "a page"),
  quote(
    "Page 1",
    "Slowly",
    "“A reader lives a thousand lives before he dies. The man who never reads lives only one.”",
    "— George R. R. Martin"
  ),
  quote(
    "Page 2",
    "Anywhere",
    "“A book is a dream that you hold in your hand.”",
    "— Neil Gaiman"
  ),
  quote(
    "Page 3",
    "Quietly",
    "“Reading is to the mind what exercise is to the body.”",
    "— Joseph Addison"
  ),
  quote(
    "Page 4",
    "Together",
    "“There is no friend as loyal as a book.”",
    "— Ernest Hemingway"
  ),
  quote(
    "Page 5",
    "Again",
    "“The books that help you most are those which make you think the most.”",
    "— Theodore Parker"
  ),
  quote(
    "Page 6",
    "Yours",
    "“Books are a uniquely portable magic.”",
    "— Stephen King"
  ),
  plate("last", "Your", "shelf"),
  { key: "blank", kind: "blank", content: null },
];

const MAX_SPREAD = Math.floor(LEAVES.length / 2);

const HOW_IT_WORKS = [
  {
    icon: Leaf,
    title: "Add a book",
    text: "Drop an EPUB on the page or choose one. It is parsed and shelved right here in your browser.",
  },
  {
    icon: BookOpen,
    title: "Read anywhere",
    text: "Turn real pages on a laptop or a phone. Your place, highlights and notes are kept for you.",
  },
  {
    icon: Users,
    title: "Read together",
    text: "Share a short room code and read the same book with friends, page by page.",
  },
] as const;

function stageLabel(single: boolean, spread: number, maxSpread: number) {
  if (spread === 0) {
    return "Closed";
  }
  return single
    ? `Page ${spread} of ${maxSpread}`
    : `Spread ${spread} of ${maxSpread}`;
}

export interface BookStageProps {
  /** `null` when the host has no persistent library. */
  library: LibraryBook[] | null;
  libraryBusy: boolean;
  onImport: () => void;
  onOpenBook: (id: string) => void;
  onRemoveBook: (book: LibraryBook) => void;
}

/**
 * The empty-library hero: a small demo book on the reading desk that invites
 * a first page turn, followed by three "how it works" cards. The shelf
 * itself lives in `LibraryHome`.
 */
export function BookStage(props: BookStageProps) {
  const { library, onImport } = props;
  const frame = useRef<HTMLElement>(null);
  const size = useElementSize(frame);
  const single = useMediaQuery("(max-width: 767px)");
  const [page, setPage] = useState(1);
  const [turning, setTurning] = useState(false);
  const spread = single ? page : Math.floor(page / 2);
  const maxSpread = single ? LEAVES.length : MAX_SPREAD;

  const turnLeaf = useCallback(
    (direction: 1 | -1) => {
      if (turning) {
        return;
      }
      setPage((current) => {
        const step = single ? 1 : 2;
        const forward = !single && current <= 1 ? 2 : current + step;
        return Math.min(
          LEAVES.length,
          Math.max(1, direction === 1 ? forward : current - step)
        );
      });
    },
    [turning, single]
  );

  useArrowTurns(turnLeaf);

  return (
    <div className="library-empty">
      <section aria-labelledby="book-stage-title" className="book-stage">
        <p className="book-hint" data-hidden={spread > 0}>
          <span>Drag a corner to turn the page</span>
          <ArrowLeft aria-hidden="true" />
        </p>

        <section
          aria-label="A short book of reading quotes"
          className={cn(
            "curl-book curl-book--demo",
            single && "curl-book--single"
          )}
          ref={frame}
        >
          <TurnBook
            display={single ? "single" : "double"}
            height={size.height}
            leaves={LEAVES}
            onTurned={(next) => {
              setTurning(false);
              setPage(next);
            }}
            onTurning={() => setTurning(true)}
            page={page}
            width={size.width}
          />
        </section>

        <div className="book-controls">
          <Button
            aria-label="Previous page"
            disabled={spread <= (single ? 1 : 0) || turning}
            onClick={() => turnLeaf(-1)}
            size="icon"
            variant="ghost"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span aria-live="polite">
            {stageLabel(single, spread, maxSpread)}
          </span>
          <Button
            aria-label="Next page"
            disabled={spread === maxSpread || turning}
            onClick={() => turnLeaf(1)}
            size="icon"
            variant="ghost"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>

        <div className="book-invite">
          <h2 id="book-stage-title">Books open here. They stay here.</h2>
          <p>
            {library
              ? "Leaflet keeps your library in this browser, remembers your place, and lets you ask your own AI model about what you read. Nothing leaves your device unless you send it."
              : "Leaflet pairs considered reading with local intelligence, without turning your library into someone else’s dataset."}
          </p>
          <Button
            className="bg-coral text-coral-foreground hover:bg-coral/90"
            onClick={onImport}
            size="lg"
          >
            <Leaf className="size-4" />
            Open your first EPUB
          </Button>
        </div>
      </section>

      <ul aria-label="How Leaflet works" className="how-cards">
        {HOW_IT_WORKS.map(({ icon: Icon, title, text }) => (
          <li className="how-card paper" key={title}>
            <span className="how-card__icon">
              <Icon className="size-5" />
            </span>
            <h3>{title}</h3>
            <p>{text}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
