/**
 * Reading settings (plan W1.14): theme (light / sepia / dark), font size and
 * line width, kept per document (a book or a clipped note), and the last
 * chapter read in a book. Browser storage — a per-device convenience; a
 * blocked or empty store just gives the defaults.
 */

export type ReaderTheme = "light" | "sepia" | "dark";

export interface ReaderPrefs {
  theme: ReaderTheme;
  /** Font size in px (14–32). */
  fontSize: number;
  /** Line width in characters (40–100). */
  width: number;
}

export const DEFAULT_PREFS: ReaderPrefs = { theme: "light", fontSize: 18, width: 66 };
const KEY = "lumen.reader:";

type KV = Pick<Storage, "getItem" | "setItem">;
const store = (): KV | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

const clamp = (n: unknown, lo: number, hi: number, d: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d);

export function loadPrefs(docPath: string, kv: KV | null = store()): ReaderPrefs & { chapter: number } {
  try {
    const raw = JSON.parse(kv?.getItem(KEY + docPath) ?? "null") as Partial<ReaderPrefs & { chapter: number }> | null;
    return {
      theme: raw?.theme === "sepia" || raw?.theme === "dark" ? raw.theme : "light",
      fontSize: clamp(raw?.fontSize, 14, 32, DEFAULT_PREFS.fontSize),
      width: clamp(raw?.width, 40, 100, DEFAULT_PREFS.width),
      chapter: clamp(raw?.chapter, 0, 100_000, 0),
    };
  } catch {
    return { ...DEFAULT_PREFS, chapter: 0 };
  }
}

export function savePrefs(docPath: string, prefs: ReaderPrefs & { chapter?: number }, kv: KV | null = store()): void {
  try {
    kv?.setItem(KEY + docPath, JSON.stringify(prefs));
  } catch {
    // why: storage is blocked or full (private mode, quota): the setting holds for this session only
    /* blocked: this session only */
  }
}

export const THEMES: Record<ReaderTheme, { bg: string; fg: string; mark: string }> = {
  light: { bg: "#ffffff", fg: "#1f2328", mark: "rgba(250, 204, 21, 0.45)" },
  sepia: { bg: "#f4ecd8", fg: "#433422", mark: "rgba(214, 160, 50, 0.45)" },
  dark: { bg: "#1b1d22", fg: "#d7dae0", mark: "rgba(250, 204, 21, 0.3)" },
};
