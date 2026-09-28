import { useEffect, useState } from "react";

export type ColorMode = "paper" | "night";

export interface ReadingPrefs {
  colorMode: ColorMode;
  fontScale: number;
}

export const FONT_SCALE = { min: 0.76, max: 1.4, step: 0.08 };

const STORAGE_KEY = "leaflet.reading-prefs";
/** Matches the `theme-color` metas in index.html and the paper tokens. */
const THEME_COLOR: Record<ColorMode, string> = {
  paper: "#f4efe3",
  night: "#2a2521",
};

function clampFontScale(value: number): number {
  return Number.isFinite(value)
    ? Math.min(FONT_SCALE.max, Math.max(FONT_SCALE.min, value))
    : 1;
}

function systemMode(): ColorMode {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "night"
    : "paper";
}

function restore(): ReadingPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return { fontScale: 1, colorMode: systemMode() };
    }
    const parsed = JSON.parse(raw) as Partial<ReadingPrefs>;
    return {
      fontScale: clampFontScale(Number(parsed.fontScale)),
      colorMode: parsed.colorMode === "night" ? "night" : "paper",
    };
  } catch {
    return { fontScale: 1, colorMode: systemMode() };
  }
}

function persist(prefs: ReadingPrefs): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}

function applyTheme(mode: ColorMode): void {
  document.documentElement.classList.toggle("dark", mode === "night");
  document.documentElement.style.colorScheme =
    mode === "night" ? "dark" : "light";
  for (const meta of document.querySelectorAll<HTMLMetaElement>(
    'meta[name="theme-color"]'
  )) {
    meta.content = THEME_COLOR[mode];
  }
}

export function useReadingPrefs() {
  const [prefs, setPrefs] = useState(restore);

  useEffect(() => {
    persist(prefs);
    applyTheme(prefs.colorMode);
  }, [prefs]);

  return {
    ...prefs,
    setFontScale: (fontScale: number) =>
      setPrefs((current) => ({
        ...current,
        fontScale: clampFontScale(fontScale),
      })),
    stepFontScale: (direction: 1 | -1) =>
      setPrefs((current) => ({
        ...current,
        fontScale: clampFontScale(
          current.fontScale + direction * FONT_SCALE.step
        ),
      })),
    setNight: (night: boolean) =>
      setPrefs((current) => ({
        ...current,
        colorMode: night ? "night" : "paper",
      })),
  };
}
