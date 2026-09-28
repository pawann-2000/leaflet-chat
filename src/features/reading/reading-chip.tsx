import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(rest)}`
    : `${pad(minutes)}:${pad(rest)}`;
}

/**
 * The little pill in the reader header: a breathing dot while time counts,
 * the sitting's clock, and a gold check once today's goal is met.
 */
export function ReadingTimerChip({
  seconds,
  active,
  goalMet,
  onClick,
  className,
}: {
  active: boolean;
  className?: string;
  goalMet: boolean;
  onClick?: () => void;
  seconds: number;
}) {
  const title = `${active ? "Reading time is counting" : "Reading time is paused"} · ${formatClock(seconds)} this sitting${goalMet ? " · daily goal reached" : ""}`;
  const body = (
    <>
      <span aria-hidden="true" className="reading-chip__dot" />
      <span className="reading-chip__time">{formatClock(seconds)}</span>
      {goalMet && (
        <span className="reading-chip__check">
          <Check aria-hidden="true" className="size-2.5" strokeWidth={3} />
          <span className="sr-only">Daily goal reached</span>
        </span>
      )}
    </>
  );
  const classes = cn(
    "reading-chip",
    active && "reading-chip--active",
    className
  );
  if (onClick) {
    return (
      <button
        aria-label={title}
        className={classes}
        onClick={onClick}
        title={title}
        type="button"
      >
        {body}
      </button>
    );
  }
  return (
    <span className={classes} role="status" title={title}>
      {body}
    </span>
  );
}
