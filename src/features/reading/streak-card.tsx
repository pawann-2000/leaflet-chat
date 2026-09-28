import { Leaf } from "lucide-react";
import type { ReadingDayRecord } from "@/lib/db/types";
import type { ReadingOverview } from "@/lib/reading";
import { cn } from "@/lib/utils";

const GOAL_MINUTES = [10, 15, 20, 30, 45, 60];
const RING_RADIUS = 27;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

const dayLabel = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});

function compact(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 10_000) {
    return `${Math.round(value / 1000)}k`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return String(value);
}

function minutesOf(seconds: number): number {
  return Math.round(seconds / 60);
}

function headline(overview: ReadingOverview): string {
  if (overview.streakDays >= 2) {
    return `${overview.streakDays}-day streak`;
  }
  if (overview.streakDays === 1) {
    return overview.goalMet ? "Streak started" : "A one-day streak";
  }
  return overview.todaySeconds > 0 ? "Today counts" : "Start a streak today";
}

function encouragement(overview: ReadingOverview): string {
  const goalMinutes = minutesOf(overview.goalSeconds);
  if (overview.todaySeconds === 0 && overview.totalSeconds === 0) {
    return "Read for a few minutes to plant your first leaf.";
  }
  if (overview.goalMet) {
    return overview.bestStreak > overview.streakDays
      ? `Goal done. Your best streak is ${overview.bestStreak} days.`
      : "Goal done for today. Every page from here is a bonus.";
  }
  const left = Math.max(1, goalMinutes - minutesOf(overview.todaySeconds));
  return overview.todaySeconds > 0
    ? `${left} more ${left === 1 ? "minute" : "minutes"} keeps the streak alive.`
    : `${goalMinutes} minutes today keeps the streak alive.`;
}

function dayTone(day: ReadingDayRecord, goalSeconds: number): string {
  if (day.seconds <= 0) {
    return "";
  }
  if (day.seconds >= goalSeconds) {
    return "streak-day--done";
  }
  return day.seconds >= goalSeconds / 4
    ? "streak-day--most"
    : "streak-day--some";
}

function Ring({
  seconds,
  goalSeconds,
}: {
  goalSeconds: number;
  seconds: number;
}) {
  const ratio = goalSeconds > 0 ? Math.min(1, seconds / goalSeconds) : 0;
  return (
    <div
      aria-label={`${minutesOf(seconds)} of ${minutesOf(goalSeconds)} minutes today`}
      className={cn("streak-ring", ratio >= 1 && "streak-ring--done")}
      role="img"
    >
      <svg aria-hidden="true" viewBox="0 0 64 64">
        <circle
          className="streak-ring__track"
          cx="32"
          cy="32"
          r={RING_RADIUS}
        />
        <circle
          className="streak-ring__fill"
          cx="32"
          cy="32"
          r={RING_RADIUS}
          strokeDasharray={RING_LENGTH}
          strokeDashoffset={RING_LENGTH * (1 - ratio)}
        />
      </svg>
      <span className="streak-ring__value">
        {minutesOf(seconds)}
        <span className="streak-ring__unit">min</span>
      </span>
    </div>
  );
}

/**
 * Today's ring, the streak, a 28-day calendar and the daily goal stepper.
 * Renders an encouraging empty state for a fresh library.
 */
export function StreakCard({
  overview,
  onGoalChange,
  compact: isCompact = false,
  className,
}: {
  className?: string;
  compact?: boolean;
  onGoalChange?: (seconds: number) => void;
  overview: ReadingOverview;
}) {
  const today = overview.days.at(-1)?.date;
  const facts = [
    overview.averageWpm !== null && `${overview.averageWpm} wpm`,
    overview.totalWords > 0 && `${compact(overview.totalWords)} words`,
    overview.booksTouched > 0 &&
      `${overview.booksTouched} ${overview.booksTouched === 1 ? "book" : "books"}`,
  ].filter((fact): fact is string => Boolean(fact));

  return (
    <section
      aria-label="Reading streak"
      className={cn(
        "paper streak-card",
        isCompact && "streak-card--compact",
        className
      )}
    >
      <Ring
        goalSeconds={overview.goalSeconds}
        seconds={overview.todaySeconds}
      />
      <div className="streak-card__body">
        <h3 className="streak-card__headline">
          <Leaf aria-hidden="true" className="size-5" />
          {headline(overview)}
        </h3>
        <p className="streak-card__line">{encouragement(overview)}</p>
        {facts.length > 0 && (
          <p className="streak-card__facts">
            {facts.map((fact) => (
              <span className="eyebrow" key={fact}>
                {fact}
              </span>
            ))}
          </p>
        )}
      </div>
      {!isCompact && (
        <ol aria-label="Last 28 days" className="streak-calendar">
          {overview.days.map((day) => (
            <li
              aria-label={`${dayLabel.format(new Date(`${day.date}T12:00:00`))}: ${minutesOf(day.seconds)} minutes`}
              className={cn(
                "streak-day",
                dayTone(day, overview.goalSeconds),
                day.date === today && "streak-day--today"
              )}
              key={day.date}
              title={`${day.date} · ${minutesOf(day.seconds)} min`}
            />
          ))}
        </ol>
      )}
      {!isCompact && onGoalChange && (
        <fieldset className="streak-goals">
          <legend className="sr-only">Daily reading goal</legend>
          <span aria-hidden="true" className="eyebrow streak-goals__label">
            Daily goal
          </span>
          {GOAL_MINUTES.map((minutes) => (
            <button
              aria-pressed={minutesOf(overview.goalSeconds) === minutes}
              className="streak-goal"
              key={minutes}
              onClick={() => onGoalChange(minutes * 60)}
              type="button"
            >
              {minutes} min
            </button>
          ))}
        </fieldset>
      )}
    </section>
  );
}
