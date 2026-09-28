import { Leaf } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useEffect } from "react";
import { createPortal } from "react-dom";

const DURATION_MS = 1400;
const COLOURS = ["var(--gold)", "var(--coral)", "var(--leaf)"];

/** Fourteen sparks fanned around the middle of the screen, precomputed so the burst is stable. */
const SPARKS = Array.from({ length: 14 }, (_, index) => {
  const angle = (index / 14) * Math.PI * 2 + (index % 2 ? 0.35 : 0);
  const radius = 14 + (index % 3) * 9;
  return {
    id: index,
    left: `${50 + Math.cos(angle) * radius}vw`,
    top: `${46 + Math.sin(angle) * radius * 0.9}vh`,
    delay: `${(index % 5) * 70}ms`,
    colour: COLOURS[index % COLOURS.length],
    size: `${1.2 + (index % 4) * 0.35}rem`,
  };
});

/**
 * A brief, subtle burst when the daily goal is reached: gold, coral and leaf
 * sparks plus a small paper toast. Resolves itself through `onDone`.
 */
export function GoalCelebration({
  show,
  onDone,
}: {
  onDone: () => void;
  show: boolean;
}) {
  const reduce = useReducedMotion();

  useEffect(() => {
    if (!show) {
      return;
    }
    const timer = setTimeout(onDone, DURATION_MS);
    return () => clearTimeout(timer);
  }, [show, onDone]);

  if (!show || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div aria-live="polite" className="celebration" role="status">
      {!reduce &&
        SPARKS.map((spark) => (
          <span
            aria-hidden="true"
            className="celebration__spark"
            key={spark.id}
            style={{
              left: spark.left,
              top: spark.top,
              color: spark.colour,
              fontSize: spark.size,
              animationDelay: spark.delay,
            }}
          >
            ✦
          </span>
        ))}
      <p className="paper celebration__toast">
        <Leaf aria-hidden="true" className="size-4" />
        Daily goal reached
      </p>
    </div>,
    document.body
  );
}
