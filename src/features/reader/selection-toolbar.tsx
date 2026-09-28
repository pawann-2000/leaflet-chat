import {
  Copy,
  Highlighter,
  MessageSquarePlus,
  Sparkles,
  Zap,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { SPRING_PANEL } from "@/lib/ease";
import type { ReaderSelection } from "@/lib/reader/locator";

export type SelectionAction = "highlight" | "note" | "copy" | "ask" | "speed";

export interface SelectionToolbarProps {
  /** Whether highlights and notes may be saved right now (read-only rooms disable them). */
  canAnnotate: boolean;
  onAction: (action: SelectionAction, selection: ReaderSelection) => void;
  /** The current reader selection, as computed by the book. `null` hides the toolbar. */
  selection: ReaderSelection | null;
  /** The reader stage; the toolbar only reacts to selections inside it. */
  stageRef: RefObject<HTMLElement | null>;
}

interface Placement {
  below: boolean;
  left: number;
  top: number;
}

const MARGIN = 12;
const ESTIMATED_WIDTH = 300;
const ESTIMATED_HEIGHT = 44;

function isTouchPointer(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(pointer: coarse)").matches === true
  );
}

/**
 * Where to put the pill for the live browser selection. Above the selection on
 * mouse devices, below it on touch devices so the native selection handles and
 * the platform's own menu stay reachable.
 */
function placeToolbar(stage: HTMLElement): Placement | null {
  const live = window.getSelection();
  if (!live || live.isCollapsed || live.rangeCount === 0) {
    return null;
  }
  const range = live.getRangeAt(0);
  if (!stage.contains(range.commonAncestorContainer)) {
    return null;
  }
  const rects = [...range.getClientRects()];
  const box = range.getBoundingClientRect();
  if (!rects.length || (box.width === 0 && box.height === 0)) {
    return null;
  }
  const first = rects[0];
  const last = rects.at(-1) ?? first;
  const touch = isTouchPointer();
  const anchor = touch ? last : first;
  const centre = touch
    ? anchor.left + anchor.width / 2
    : Math.min(Math.max(box.left + box.width / 2, first.left), first.right);
  const width = Math.min(ESTIMATED_WIDTH, window.innerWidth - 2 * MARGIN);
  const left = Math.min(
    Math.max(centre - width / 2, MARGIN),
    window.innerWidth - width - MARGIN
  );
  const roomAbove = anchor.top - MARGIN - ESTIMATED_HEIGHT;
  const below = touch || roomAbove < MARGIN;
  const top = below
    ? Math.min(
        anchor.bottom + MARGIN,
        window.innerHeight - ESTIMATED_HEIGHT - MARGIN
      )
    : roomAbove;
  return { left, top, below };
}

export function SelectionToolbar({
  stageRef,
  selection,
  canAnnotate,
  onAction,
}: SelectionToolbarProps) {
  const reduce = useReducedMotion();
  const [placement, setPlacement] = useState<Placement | null>(null);

  // Position from the live browser selection; re-place on resize and scroll
  // so the pill follows the text when the layout moves.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!(selection && stage)) {
      setPlacement(null);
      return;
    }
    const update = () => setPlacement(placeToolbar(stage));
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [selection, stageRef]);

  // The pill must not steal the selection: pressing a button would normally
  // collapse it before the click lands.
  const keepSelection = (event: ReactPointerEvent) => event.preventDefault();

  useEffect(() => {
    if (!selection) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        window.getSelection()?.removeAllRanges();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection]);

  const visible = Boolean(selection && placement);
  const shortQuote = selection?.text.replace(/\s+/gu, " ").trim() ?? "";

  return createPortal(
    <AnimatePresence>
      {visible && selection && placement && (
        <motion.div
          animate={{ opacity: 1, scale: 1, y: 0 }}
          aria-label="Selected text actions"
          className="selection-toolbar"
          data-below={placement.below}
          exit={{ opacity: 0, scale: 0.96, y: placement.below ? 4 : -4 }}
          initial={
            reduce
              ? { opacity: 0 }
              : { opacity: 0, scale: 0.92, y: placement.below ? 6 : -6 }
          }
          key={`${selection.locator.chapterId}:${selection.locator.start}:${selection.locator.end}`}
          onPointerDown={keepSelection}
          role="toolbar"
          style={{ left: placement.left, top: placement.top }}
          transition={reduce ? { duration: 0.12 } : SPRING_PANEL}
        >
          <button
            aria-label="Highlight"
            className="selection-toolbar__button selection-toolbar__button--gold"
            disabled={!canAnnotate}
            onClick={() => onAction("highlight", selection)}
            title={canAnnotate ? "Highlight" : "Read-only room"}
            type="button"
          >
            <Highlighter aria-hidden="true" />
            <span>Highlight</span>
          </button>
          <button
            aria-label="Add a note"
            className="selection-toolbar__button"
            disabled={!canAnnotate}
            onClick={() => onAction("note", selection)}
            title={canAnnotate ? "Add a note" : "Read-only room"}
            type="button"
          >
            <MessageSquarePlus aria-hidden="true" />
            <span>Note</span>
          </button>
          <button
            aria-label="Copy"
            className="selection-toolbar__button"
            onClick={() => onAction("copy", selection)}
            title={`Copy “${shortQuote.slice(0, 40)}${shortQuote.length > 40 ? "…" : ""}”`}
            type="button"
          >
            <Copy aria-hidden="true" />
            <span>Copy</span>
          </button>
          <button
            aria-label="Ask about this passage"
            className="selection-toolbar__button"
            onClick={() => onAction("ask", selection)}
            title="Ask about this passage"
            type="button"
          >
            <Sparkles aria-hidden="true" />
            <span>Ask</span>
          </button>
          <button
            aria-label="Speed read from here"
            className="selection-toolbar__button selection-toolbar__button--coral"
            onClick={() => onAction("speed", selection)}
            title="Speed read from here"
            type="button"
          >
            <Zap aria-hidden="true" />
            <span>Speed</span>
          </button>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
