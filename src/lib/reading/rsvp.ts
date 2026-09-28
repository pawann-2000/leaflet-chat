/**
 * Rapid serial visual presentation: the engine behind the speed reader.
 * Pure — no DOM, injectable timers — so the pacing is unit-testable.
 */

export interface RsvpToken {
  /** UTF-16 offset of the token's first character in the source text. */
  offset: number;
  /** 0-based index of the focus letter within `text`. */
  orp: number;
  paragraphStart: boolean;
  sentenceStart: boolean;
  text: string;
  /** Duration multiplier, ≥ 1. */
  weight: number;
  /** Words in this frame (1 for single-word frames). */
  words: number;
}

export interface RsvpState {
  done: boolean;
  effectiveWpm: number;
  elapsedMs: number;
  index: number;
  playing: boolean;
  /** 0..1 position through the token list. */
  progress: number;
  total: number;
  wordsShown: number;
  wpm: number;
}

export interface RsvpController {
  destroy(): void;
  pause(): void;
  play(): void;
  seek(index: number): void;
  setWpm(wpm: number): void;
  skipSentence(direction: 1 | -1): void;
  readonly state: RsvpState;
  subscribe(listener: (state: RsvpState) => void): () => void;
  toggle(): void;
}

export interface RsvpOptions {
  clearTimeout?: (handle: unknown) => void;
  maxWpm?: number;
  minWpm?: number;
  now?: () => number;
  /** Warm-up: start at 60% of `wpm`, reach 100% after this long, each time play starts. */
  rampMs?: number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  wpm: number;
}

export const RSVP_MIN_WPM = 100;
export const RSVP_MAX_WPM = 1200;
export const RSVP_DEFAULT_RAMP_MS = 8000;
const RAMP_START = 0.6;

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const TRAILING_PUNCTUATION = /[^\p{L}\p{N}]+$/u;
const LEADING_PUNCTUATION = /^[^\p{L}\p{N}]+/u;
const SENTENCE_END = /[.!?…]/u;
const CLAUSE_END = /[,;:]/u;
const DIGIT = /\d/u;
const WORD_RUN = /\S+/gu;
const NEWLINE = /\n/u;

/** Optimal recognition point: the letter the eye should land on. */
export function orpIndex(word: string): number {
  const lead = word.search(LETTER_OR_DIGIT);
  if (lead < 0) {
    return 0;
  }
  const core = word.slice(lead).replace(TRAILING_PUNCTUATION, "");
  const length = core.length;
  if (length <= 1) {
    return lead;
  }
  if (length <= 5) {
    return lead + 1;
  }
  if (length <= 9) {
    return lead + 2;
  }
  if (length <= 13) {
    return lead + 3;
  }
  return lead + 4;
}

interface SourceWord {
  offset: number;
  paragraphEnd: boolean;
  paragraphStart: boolean;
  sentenceEnd: boolean;
  sentenceStart: boolean;
  text: string;
  weight: number;
}

function coreOf(word: string): string {
  return word
    .replace(LEADING_PUNCTUATION, "")
    .replace(TRAILING_PUNCTUATION, "");
}

function trailingOf(word: string): string {
  const match = TRAILING_PUNCTUATION.exec(word);
  return match ? match[0] : "";
}

function baseWeight(word: string): number {
  const core = coreOf(word);
  const trailing = trailingOf(word);
  let weight = 1;
  if (core.length >= 8) {
    weight += 0.4;
  }
  if (DIGIT.test(core)) {
    weight += 0.3;
  }
  if (SENTENCE_END.test(trailing)) {
    weight += 1.6;
  } else if (CLAUSE_END.test(trailing)) {
    weight += 0.8;
  }
  return weight;
}

function splitWords(text: string): SourceWord[] {
  const words: SourceWord[] = [];
  let previousEnd = 0;
  let sentenceStart = true;
  let paragraphStart = true;
  for (const match of text.matchAll(WORD_RUN)) {
    const word = match[0];
    const offset = match.index;
    const gap = text.slice(previousEnd, offset);
    const breaksParagraph = NEWLINE.test(gap);
    const last = words.at(-1);
    if (breaksParagraph && last) {
      last.paragraphEnd = true;
      last.weight += 2.5;
    }
    const entry: SourceWord = {
      text: word,
      offset,
      weight: baseWeight(word),
      sentenceStart: sentenceStart || breaksParagraph,
      paragraphStart: paragraphStart || breaksParagraph,
      sentenceEnd: SENTENCE_END.test(trailingOf(word)),
      paragraphEnd: false,
    };
    words.push(entry);
    sentenceStart = entry.sentenceEnd;
    paragraphStart = false;
    previousEnd = offset + word.length;
  }
  return words;
}

function frameOf(group: SourceWord[]): RsvpToken {
  const text = group.map((word) => word.text).join(" ");
  let longest = group[0];
  let longestStart = 0;
  let cursor = 0;
  for (const word of group) {
    if (word.text.length > longest.text.length) {
      longest = word;
      longestStart = cursor;
    }
    cursor += word.text.length + 1;
  }
  const weight =
    group.reduce((sum, word) => sum + word.weight, 0) / group.length;
  return {
    text,
    orp: longestStart + orpIndex(longest.text),
    weight: Math.max(1, weight),
    offset: group[0].offset,
    sentenceStart: group[0].sentenceStart,
    paragraphStart: group[0].paragraphStart,
    words: group.length,
  };
}

/**
 * Split text into RSVP frames of one to three words. Frames never cross a
 * sentence or paragraph boundary, so the pause lands where the reader expects it.
 */
export function tokenizeRsvp(
  text: string,
  options: { wordsPerFrame?: 1 | 2 | 3 } = {}
): RsvpToken[] {
  const perFrame = options.wordsPerFrame ?? 1;
  const words = splitWords(text);
  const frames: RsvpToken[] = [];
  let group: SourceWord[] = [];
  for (const word of words) {
    group.push(word);
    if (group.length >= perFrame || word.sentenceEnd || word.paragraphEnd) {
      frames.push(frameOf(group));
      group = [];
    }
  }
  if (group.length) {
    frames.push(frameOf(group));
  }
  return frames;
}

/** Index of the first frame at or after `offset` (or the frame containing it). */
export function frameIndexAtOffset(
  tokens: readonly RsvpToken[],
  offset: number
): number {
  if (!tokens.length) {
    return 0;
  }
  let index = 0;
  for (let cursor = 0; cursor < tokens.length; cursor += 1) {
    if (tokens[cursor].offset > offset) {
      break;
    }
    index = cursor;
  }
  return index;
}

function clampWpm(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.round(Math.min(max, Math.max(min, value)));
}

export function createRsvp(
  tokens: readonly RsvpToken[],
  options: RsvpOptions
): RsvpController {
  const setTimer =
    options.setTimeout ??
    ((callback, ms) => globalThis.setTimeout(callback, ms));
  const clearTimer =
    options.clearTimeout ??
    ((handle) => globalThis.clearTimeout(handle as number));
  const now = options.now ?? (() => Date.now());
  const minWpm = options.minWpm ?? RSVP_MIN_WPM;
  const maxWpm = Math.max(minWpm, options.maxWpm ?? RSVP_MAX_WPM);
  const rampMs = Math.max(0, options.rampMs ?? RSVP_DEFAULT_RAMP_MS);
  const total = tokens.length;
  const listeners = new Set<(state: RsvpState) => void>();
  const wpm = clampWpm(options.wpm, minWpm, maxWpm);
  const state: RsvpState = {
    index: 0,
    playing: false,
    wpm,
    effectiveWpm: wpm,
    total,
    progress: 0,
    wordsShown: 0,
    elapsedMs: 0,
    done: total === 0,
  };
  let timer: unknown = null;
  let frameStartedAt = 0;
  let frameDuration = 0;
  let rampStartedAt = 0;

  const emit = () => {
    const copy = { ...state };
    for (const listener of listeners) {
      listener(copy);
    }
  };

  const effectiveWpm = (at: number): number => {
    const t =
      rampMs > 0 ? Math.min(1, Math.max(0, (at - rampStartedAt) / rampMs)) : 1;
    return state.wpm * (RAMP_START + (1 - RAMP_START) * t);
  };

  const clear = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const advance = () => {
    timer = null;
    state.elapsedMs += frameDuration;
    state.wordsShown += tokens[state.index].words;
    if (state.index + 1 >= total) {
      state.done = true;
      state.playing = false;
      state.progress = 1;
      emit();
      return;
    }
    state.index += 1;
    state.progress = state.index / total;
    schedule();
    emit();
  };

  const schedule = () => {
    clear();
    const at = now();
    frameStartedAt = at;
    const speed = effectiveWpm(at);
    state.effectiveWpm = Math.round(speed);
    frameDuration = (60_000 / speed) * tokens[state.index].weight;
    timer = setTimer(advance, frameDuration);
  };

  const play = () => {
    if (state.playing || total === 0) {
      return;
    }
    if (state.done) {
      state.index = 0;
      state.done = false;
      state.progress = 0;
      state.wordsShown = 0;
      state.elapsedMs = 0;
    }
    state.playing = true;
    rampStartedAt = now();
    schedule();
    emit();
  };

  const pause = () => {
    if (!state.playing) {
      return;
    }
    clear();
    state.elapsedMs += Math.min(
      frameDuration,
      Math.max(0, now() - frameStartedAt)
    );
    state.playing = false;
    state.effectiveWpm = state.wpm;
    emit();
  };

  const seek = (index: number) => {
    if (total === 0) {
      return;
    }
    state.index = Math.min(total - 1, Math.max(0, Math.trunc(index)));
    state.done = false;
    state.progress = state.index / total;
    if (state.playing) {
      schedule();
    }
    emit();
  };

  const sentenceStartAtOrBefore = (index: number): number => {
    for (let cursor = index; cursor >= 0; cursor -= 1) {
      if (tokens[cursor].sentenceStart) {
        return cursor;
      }
    }
    return 0;
  };

  const skipSentence = (direction: 1 | -1) => {
    if (total === 0) {
      return;
    }
    if (direction === 1) {
      let next = total - 1;
      for (let cursor = state.index + 1; cursor < total; cursor += 1) {
        if (tokens[cursor].sentenceStart) {
          next = cursor;
          break;
        }
      }
      seek(next);
      return;
    }
    const start = sentenceStartAtOrBefore(state.index);
    // Mid-sentence goes back to its start; at the start goes one sentence back.
    seek(start < state.index ? start : sentenceStartAtOrBefore(start - 1));
  };

  return {
    get state() {
      return { ...state };
    },
    play,
    pause,
    toggle() {
      if (state.playing) {
        pause();
      } else {
        play();
      }
    },
    seek,
    skipSentence,
    setWpm(value) {
      const next = clampWpm(value, minWpm, maxWpm);
      if (next === state.wpm) {
        return;
      }
      state.wpm = next;
      if (state.playing) {
        schedule();
      } else {
        state.effectiveWpm = next;
      }
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      listener({ ...state });
      return () => {
        listeners.delete(listener);
      };
    },
    destroy() {
      clear();
      state.playing = false;
      listeners.clear();
    },
  };
}
