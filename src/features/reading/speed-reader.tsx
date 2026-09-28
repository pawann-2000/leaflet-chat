import {
  ChevronLeft,
  ChevronRight,
  Minus,
  Pause,
  Play,
  Plus,
  X,
} from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/motion/button";
import { RangeSlider } from "@/components/motion/range-slider";
import {
  createRsvp,
  frameIndexAtOffset,
  RSVP_MIN_WPM,
  type RsvpController,
  type RsvpState,
  tokenizeRsvp,
} from "@/lib/reading";
import { cn } from "@/lib/utils";
import { formatClock } from "./reading-chip";

export interface SpeedReaderResult {
  /** UTF-16 offset in `text` of the frame being shown when the reader closed. */
  offset: number;
  seconds: number;
  wordsRead: number;
}

export interface SpeedReaderProps {
  chunk: 1 | 2 | 3;
  onActivity?: () => void;
  onChunkChange: (chunk: 1 | 2 | 3) => void;
  onClose: (result: SpeedReaderResult) => void;
  onWpmChange: (wpm: number) => void;
  open: boolean;
  /** Where to begin, as an offset into `text`. */
  startOffset: number;
  /** Chapter plain text. */
  text: string;
  title: string;
  wpm: number;
}

const SLIDER_MAX_WPM = 1000;
const WPM_STEP = 25;
const AUTOPLAY_DELAY_MS = 800;
const ACTIVITY_INTERVAL_MS = 1000;
const CHUNKS: (1 | 2 | 3)[] = [1, 2, 3];
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function SpeedReader(props: SpeedReaderProps) {
  if (!(props.open && typeof document !== "undefined")) {
    return null;
  }
  return <SpeedReaderPanel {...props} />;
}

function clampWpm(value: number): number {
  return Math.min(SLIDER_MAX_WPM, Math.max(RSVP_MIN_WPM, Math.round(value)));
}

/** Keeps Tab cycling inside the overlay while it is open. */
function trapFocus(root: HTMLElement | null, event: KeyboardEvent): void {
  if (!root) {
    return;
  }
  const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!(first && last)) {
    return;
  }
  const active = document.activeElement;
  if (!root.contains(active)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function SpeedReaderPanel({
  title,
  text,
  startOffset,
  wpm,
  chunk,
  onWpmChange,
  onChunkChange,
  onActivity,
  onClose,
}: SpeedReaderProps) {
  const reduce = useReducedMotion();
  const tokens = useMemo(
    () => tokenizeRsvp(text, { wordsPerFrame: chunk }),
    [text, chunk]
  );
  const controller = useRef<RsvpController | null>(null);
  /** Source offset of the frame on screen; survives re-tokenising on chunk change. */
  const position = useRef(startOffset);
  const autoplayed = useRef(false);
  const lastActivity = useRef(0);
  const latest = useRef({ onActivity, onClose, wpm });
  latest.current = { onActivity, onClose, wpm };
  const root = useRef<HTMLDivElement>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<RsvpState | null>(null);

  useEffect(() => {
    // The speed is read from a ref so a wpm change never rebuilds the player;
    // it is pushed through `setWpm` below instead.
    const player = createRsvp(tokens, { wpm: latest.current.wpm });
    controller.current = player;
    player.seek(frameIndexAtOffset(tokens, position.current));
    const unsubscribe = player.subscribe((next) => {
      setState(next);
      const token = tokens[next.index];
      if (token) {
        position.current = token.offset;
      }
      const now = Date.now();
      if (next.playing && now - lastActivity.current >= ACTIVITY_INTERVAL_MS) {
        lastActivity.current = now;
        latest.current.onActivity?.();
      }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!autoplayed.current && tokens.length) {
      autoplayed.current = true;
      timer = setTimeout(() => player.play(), AUTOPLAY_DELAY_MS);
    }
    return () => {
      clearTimeout(timer);
      unsubscribe();
      player.destroy();
      controller.current = null;
    };
  }, [tokens]);

  useEffect(() => {
    controller.current?.setWpm(wpm);
  }, [wpm]);

  useEffect(() => {
    const previous = document.activeElement;
    playButton.current?.focus({ preventScroll: true });
    return () => {
      if (previous instanceof HTMLElement) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);

  const close = useCallback(() => {
    const player = controller.current;
    const current = player?.state;
    player?.pause();
    latest.current.onClose({
      offset: position.current,
      wordsRead: current?.wordsShown ?? 0,
      seconds: Math.round((current?.elapsedMs ?? 0) / 1000),
    });
  }, []);

  const changeWpm = useCallback(
    (next: number) => {
      const value = clampWpm(next);
      controller.current?.setWpm(value);
      onWpmChange(value);
    },
    [onWpmChange]
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        trapFocus(root.current, event);
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
      ) {
        return;
      }
      const player = controller.current;
      switch (event.key) {
        case " ":
        case "k":
          event.preventDefault();
          player?.toggle();
          return;
        case "ArrowLeft":
          event.preventDefault();
          player?.skipSentence(-1);
          return;
        case "ArrowRight":
          event.preventDefault();
          player?.skipSentence(1);
          return;
        case "ArrowUp":
        case "+":
        case "=":
          event.preventDefault();
          changeWpm(wpm + WPM_STEP);
          return;
        case "ArrowDown":
        case "-":
          event.preventDefault();
          changeWpm(wpm - WPM_STEP);
          return;
        case "1":
        case "2":
        case "3":
          event.preventDefault();
          onChunkChange(Number(event.key) as 1 | 2 | 3);
          return;
        case "Escape":
          event.preventDefault();
          close();
          return;
        default:
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [changeWpm, close, wpm, onChunkChange]);

  const token = state ? tokens[state.index] : undefined;
  const orp = token
    ? Math.min(token.orp, Math.max(0, token.text.length - 1))
    : 0;
  const before = token ? token.text.slice(0, orp) : "";
  const letter = token ? token.text.charAt(orp) : "";
  const after = token ? token.text.slice(orp + 1) : "";
  const playing = state?.playing ?? false;
  const warming = playing && (state?.effectiveWpm ?? wpm) < wpm - 5;
  const progress = state?.progress ?? 0;
  const wordsShown = state?.wordsShown ?? 0;
  const elapsed = Math.round((state?.elapsedMs ?? 0) / 1000);

  return createPortal(
    <div
      aria-label={`Speed reading ${title}`}
      aria-modal="true"
      className={cn("rsvp desk", !reduce && "rsvp--animate")}
      ref={root}
      role="dialog"
    >
      <header className="rsvp__top">
        <div className="rsvp__title">
          <p className="eyebrow">Speed reading</p>
          <h2>{title}</h2>
        </div>
        <Button
          aria-label="Back to the book"
          className="rsvp__close"
          onClick={close}
          size="icon"
          variant="ghost"
        >
          <X className="size-5" />
        </Button>
      </header>

      <div className="rsvp__stage">
        {tokens.length === 0 ? (
          <p className="rsvp__empty">
            Nothing to speed-read here yet. Turn to a page with text and try
            again.
          </p>
        ) : (
          <div className="paper rsvp__card">
            <span aria-hidden="true" className="rsvp__guide rsvp__guide--top" />
            <div aria-live="off" className="rsvp__word">
              <span className="rsvp__frame" key={state?.index ?? -1}>
                <span className="rsvp__before">{before}</span>
                <span className="rsvp__orp">{letter}</span>
                <span className="rsvp__after">{after}</span>
              </span>
            </div>
            <span
              aria-hidden="true"
              className="rsvp__guide rsvp__guide--bottom"
            />
            <p aria-live="polite" className="rsvp__hint" data-visible={warming}>
              {warming ? "Warming up…" : ""}
            </p>
            <progress
              aria-label="Position in chapter"
              className="rsvp__rail"
              max={1000}
              value={Math.round(progress * 1000)}
            />
          </div>
        )}
      </div>

      <footer className="paper rsvp__bar">
        <div className="rsvp__transport">
          <Button
            aria-label="Previous sentence"
            onClick={() => controller.current?.skipSentence(-1)}
            size="icon"
            variant="ghost"
          >
            <ChevronLeft className="size-5" />
          </Button>
          <button
            aria-label={playing ? "Pause" : "Play"}
            aria-pressed={playing}
            className="rsvp__play"
            disabled={tokens.length === 0}
            onClick={() => controller.current?.toggle()}
            ref={playButton}
            type="button"
          >
            {playing ? (
              <Pause className="size-6" fill="currentColor" />
            ) : (
              <Play className="size-6 translate-x-0.5" fill="currentColor" />
            )}
          </button>
          <Button
            aria-label="Next sentence"
            onClick={() => controller.current?.skipSentence(1)}
            size="icon"
            variant="ghost"
          >
            <ChevronRight className="size-5" />
          </Button>
        </div>

        <div className="rsvp__speed">
          <Button
            aria-label="Slower by 25 words per minute"
            onClick={() => changeWpm(wpm - WPM_STEP)}
            size="icon"
            variant="ghost"
          >
            <Minus className="size-4" />
          </Button>
          <RangeSlider
            aria-label="Words per minute"
            formatValueText={(value) => `${value} words per minute`}
            max={SLIDER_MAX_WPM}
            min={RSVP_MIN_WPM}
            onValueChange={changeWpm}
            showTicks={false}
            step={WPM_STEP}
            value={clampWpm(wpm)}
          />
          <Button
            aria-label="Faster by 25 words per minute"
            onClick={() => changeWpm(wpm + WPM_STEP)}
            size="icon"
            variant="ghost"
          >
            <Plus className="size-4" />
          </Button>
          <span className="rsvp__speed-label">
            {wpm} wpm
            {warming && state ? ` · warming up from ${state.effectiveWpm}` : ""}
          </span>
        </div>

        <fieldset className="rsvp__chunks">
          <legend className="sr-only">Words per frame</legend>
          {CHUNKS.map((size) => (
            <button
              aria-pressed={chunk === size}
              className="rsvp__chunk"
              key={size}
              onClick={() => onChunkChange(size)}
              type="button"
            >
              {size} {size === 1 ? "word" : "words"}
            </button>
          ))}
        </fieldset>

        <div className="rsvp__stats">
          <span>
            {formatClock(elapsed)} · {wordsShown} words
          </span>
          <Button onClick={close} size="sm" variant="outline">
            Jump back into the book here
          </Button>
        </div>
      </footer>
    </div>,
    document.body
  );
}
