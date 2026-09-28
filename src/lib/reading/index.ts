// biome-ignore-all lint/performance/noBarrelFile: single public entry point of the reading ecosystem.
export {
  DEFAULT_SPEED_READING,
  EMPTY_SNAPSHOT,
  useReadingOverview,
  useReadingTracker,
  useSpeedReadingPrefs,
} from "./hooks";
export {
  createRsvp,
  frameIndexAtOffset,
  orpIndex,
  RSVP_DEFAULT_RAMP_MS,
  RSVP_MAX_WPM,
  RSVP_MIN_WPM,
  type RsvpController,
  type RsvpOptions,
  type RsvpState,
  type RsvpToken,
  tokenizeRsvp,
} from "./rsvp";
export {
  clampGoalSeconds,
  countWords,
  DEFAULT_GOAL_SECONDS,
  dateKeyOffset,
  localDateKey,
  MAX_GOAL_SECONDS,
  MIN_GOAL_SECONDS,
  readingGoalSeconds,
  readingOverview,
  setReadingGoal,
} from "./stats";
export { type ReadingTrackerOptions, startReadingTracker } from "./tracker";
export type {
  BookReadingTotals,
  ReadingOverview,
  ReadingSnapshot,
  ReadingTracker,
} from "./types";
