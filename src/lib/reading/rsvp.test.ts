import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRsvp,
  frameIndexAtOffset,
  orpIndex,
  type RsvpState,
  tokenizeRsvp,
} from "./rsvp";

const TEXT = "The quick, brown fox. It ran 42 miles!\n\nNew paragraph here.";

function timers() {
  return {
    now: () => Date.now(),
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

describe("orpIndex", () => {
  it("lands on the recognition letter for each word length", () => {
    expect(orpIndex("a")).toBe(0);
    expect(orpIndex("the")).toBe(1);
    expect(orpIndex("quick")).toBe(1);
    expect(orpIndex("reading")).toBe(2);
    expect(orpIndex("wonderful")).toBe(2);
    expect(orpIndex("extraordinary")).toBe(3);
    expect(orpIndex("internationalization")).toBe(4);
  });

  it("ignores leading and trailing punctuation", () => {
    expect(orpIndex('"hello,')).toBe(2);
    expect(orpIndex("(fox).")).toBe(2);
    expect(orpIndex("...")).toBe(0);
  });
});

describe("tokenizeRsvp", () => {
  it("weights punctuation, long words, numbers and paragraph breaks", () => {
    const tokens = tokenizeRsvp(TEXT);
    expect(tokens.map((token) => token.text)).toEqual([
      "The",
      "quick,",
      "brown",
      "fox.",
      "It",
      "ran",
      "42",
      "miles!",
      "New",
      "paragraph",
      "here.",
    ]);
    const weights = Object.fromEntries(
      tokens.map((token) => [token.text, Number(token.weight.toFixed(2))])
    );
    expect(weights).toMatchObject({
      The: 1,
      "quick,": 1.8,
      "fox.": 2.6,
      "42": 1.3,
      "miles!": 5.1,
      paragraph: 1.4,
      "here.": 2.6,
    });
  });

  it("marks sentence and paragraph starts and keeps source offsets", () => {
    const tokens = tokenizeRsvp(TEXT);
    for (const token of tokens) {
      expect(
        TEXT.slice(token.offset).startsWith(token.text.split(" ")[0])
      ).toBe(true);
    }
    expect(tokens.map((token) => token.sentenceStart)).toEqual([
      true,
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(
      tokens.filter((token) => token.paragraphStart).map((t) => t.text)
    ).toEqual(["The", "New"]);
  });

  it("chunks words without crossing sentences and pins the ORP to the longest word", () => {
    const tokens = tokenizeRsvp(TEXT, { wordsPerFrame: 2 });
    expect(tokens.map((token) => token.text)).toEqual([
      "The quick,",
      "brown fox.",
      "It ran",
      "42 miles!",
      "New paragraph",
      "here.",
    ]);
    expect(tokens[0].words).toBe(2);
    expect(tokens[0].weight).toBeCloseTo(1.4, 5);
    expect(tokens[0].text[tokens[0].orp]).toBe("u");
    expect(tokens[4].text[tokens[4].orp]).toBe("r");
    expect(tokens[0].offset).toBe(0);
    expect(tokens[2].offset).toBe(TEXT.indexOf("It"));
    expect(tokenizeRsvp("", { wordsPerFrame: 3 })).toEqual([]);
  });

  it("finds the frame containing a source offset", () => {
    const tokens = tokenizeRsvp(TEXT);
    expect(frameIndexAtOffset(tokens, 0)).toBe(0);
    expect(frameIndexAtOffset(tokens, TEXT.indexOf("brown") + 2)).toBe(2);
    expect(frameIndexAtOffset(tokens, 10_000)).toBe(tokens.length - 1);
    expect(frameIndexAtOffset([], 5)).toBe(0);
  });
});

describe("createRsvp", () => {
  const tokens = tokenizeRsvp("One two three. Four five.");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("paces frames by weight and finishes at the end", () => {
    const states: RsvpState[] = [];
    const player = createRsvp(tokens, { wpm: 600, rampMs: 0, ...timers() });
    player.subscribe((state) => states.push(state));
    player.play();
    expect(player.state).toMatchObject({ playing: true, index: 0 });
    vi.advanceTimersByTime(100);
    expect(player.state.index).toBe(1);
    vi.advanceTimersByTime(100);
    expect(player.state.index).toBe(2);
    // "three." carries the sentence pause: 100 ms × 2.6.
    vi.advanceTimersByTime(259);
    expect(player.state.index).toBe(2);
    vi.advanceTimersByTime(1);
    expect(player.state.index).toBe(3);
    vi.advanceTimersByTime(100 + 260);
    expect(player.state).toMatchObject({
      done: true,
      playing: false,
      progress: 1,
      wordsShown: 5,
    });
    expect(player.state.elapsedMs).toBeCloseTo(820, 5);
    // Playing again starts over.
    player.play();
    expect(player.state).toMatchObject({
      index: 0,
      done: false,
      wordsShown: 0,
    });
    player.destroy();
    expect(states.at(-1)?.playing).toBe(true);
  });

  it("warms up from 60% of the target speed", () => {
    const player = createRsvp(tokens, { wpm: 600, rampMs: 1000, ...timers() });
    player.play();
    expect(player.state.effectiveWpm).toBe(360);
    // First frame at 360 wpm lasts ~166.7 ms (fake timers truncate to 166).
    vi.advanceTimersByTime(165);
    expect(player.state.index).toBe(0);
    vi.advanceTimersByTime(2);
    expect(player.state.index).toBe(1);
    vi.advanceTimersByTime(1500);
    player.pause();
    player.play();
    expect(player.state.effectiveWpm).toBe(360);
    player.destroy();
  });

  it("seeks, skips sentences and clamps speed", () => {
    const player = createRsvp(tokens, { wpm: 300, ...timers() });
    player.skipSentence(1);
    expect(player.state.index).toBe(3);
    player.skipSentence(1);
    expect(player.state.index).toBe(4);
    player.skipSentence(-1);
    expect(player.state.index).toBe(3);
    player.skipSentence(-1);
    expect(player.state.index).toBe(0);
    player.seek(-5);
    expect(player.state.index).toBe(0);
    player.seek(100);
    expect(player.state).toMatchObject({ index: 4, progress: 0.8 });
    player.setWpm(5);
    expect(player.state.wpm).toBe(100);
    player.setWpm(5000);
    expect(player.state.wpm).toBe(1200);
    player.destroy();
  });

  it("keeps its place across pause and resume", () => {
    const player = createRsvp(tokens, { wpm: 600, rampMs: 0, ...timers() });
    player.play();
    vi.advanceTimersByTime(50);
    player.pause();
    expect(player.state).toMatchObject({ playing: false, index: 0 });
    expect(player.state.elapsedMs).toBe(50);
    vi.advanceTimersByTime(1000);
    expect(player.state.index).toBe(0);
    player.toggle();
    vi.advanceTimersByTime(100);
    expect(player.state.index).toBe(1);
    player.toggle();
    expect(player.state.playing).toBe(false);
    player.destroy();
    expect(createRsvp([], { wpm: 300 }).state.done).toBe(true);
  });
});
