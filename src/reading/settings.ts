/**
 * Reading options (plan W3.5): the face, size, line height and column
 * width of the preview, for all notes or for one note, and two aids — a
 * dyslexia-friendly face for Latin text and a spaced layout for Hebrew.
 *
 * Settings live in localStorage (`lumen-reading`): one global set, and
 * per-note overrides keyed by the note's workspace path. A note is never
 * rewritten to store them. They reach the page as CSS custom properties on
 * <html> (index.css, `.prose-lumen`), and the chosen faces are downloaded
 * then (./fonts.ts) — never at startup unless chosen.
 */
import { DYSLEXIA_FONT, HEBREW_FONTS, loadReadingFont, type ReadingFont, type ReadingFontId } from "./fonts";

export interface ReadingSettings {
  font: ReadingFontId;
  /** Preview body size in px. */
  size: number;
  /** Unitless line height. */
  lineHeight: number;
  /** Column width in `ch`. */
  width: number;
  /** OpenDyslexic for Latin text (Hebrew keeps its face). */
  dyslexiaLatin: boolean;
  /** Wider word and letter spacing and taller lines, for Hebrew. */
  spacedHebrew: boolean;
}

export const READING_LIMITS = {
  size: { min: 14, max: 28, step: 1 },
  lineHeight: { min: 1.3, max: 2.4, step: 0.05 },
  width: { min: 40, max: 120, step: 2 },
} as const;

export const DEFAULT_READING: Readonly<ReadingSettings> = Object.freeze({
  font: "default",
  size: 17,
  lineHeight: 1.7,
  width: 72,
  dyslexiaLatin: false,
  spacedHebrew: false,
});

const KEY = "lumen-reading";
const FONT_IDS = new Set<string>(["default", ...HEBREW_FONTS.map((f) => f.id)]);

interface Stored {
  global?: Partial<ReadingSettings>;
  notes?: Record<string, Partial<ReadingSettings>>;
}

const clamp = (n: unknown, { min, max }: { min: number; max: number }, d: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d);

/** Any stored value made valid (unknown face → default, numbers clamped). */
export function normalize(v: Partial<ReadingSettings> | undefined, base: Readonly<ReadingSettings> = DEFAULT_READING): ReadingSettings {
  const s = v ?? {};
  return {
    font: typeof s.font === "string" && FONT_IDS.has(s.font) ? s.font : base.font,
    size: clamp(s.size, READING_LIMITS.size, base.size),
    lineHeight: clamp(s.lineHeight, READING_LIMITS.lineHeight, base.lineHeight),
    width: clamp(s.width, READING_LIMITS.width, base.width),
    dyslexiaLatin: typeof s.dyslexiaLatin === "boolean" ? s.dyslexiaLatin : base.dyslexiaLatin,
    spacedHebrew: typeof s.spacedHebrew === "boolean" ? s.spacedHebrew : base.spacedHebrew,
  };
}

function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === "object" ? (v as Stored) : {};
  } catch {
    return {};
  }
}

function write(s: Stored): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // why: storage is blocked or full (private mode, quota): the setting holds for this session only
    /* private mode: the settings last for this visit */
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event("lumen-reading-changed"));
}

export function globalReading(): ReadingSettings {
  return normalize(read().global);
}

/** The note's own settings, or null when it follows the global ones. */
export function noteReading(path: string | null | undefined): ReadingSettings | null {
  if (!path) return null;
  const own = read().notes?.[path];
  return own ? normalize(own, globalReading()) : null;
}

/** What the note shows: its own settings, else the global ones. */
export function effectiveReading(path: string | null | undefined): ReadingSettings {
  return noteReading(path) ?? globalReading();
}

export function saveGlobalReading(v: ReadingSettings): void {
  const s = read();
  write({ ...s, global: normalize(v) });
}

export function saveNoteReading(path: string, v: ReadingSettings | null): void {
  const s = read();
  const notes = { ...(s.notes ?? {}) };
  if (v) notes[path] = normalize(v);
  else delete notes[path];
  write({ ...s, notes });
}

/** A renamed or moved note — or every note of a moved folder — keeps its settings. */
export function moveNoteReading(from: string, to: string): void {
  const s = read();
  if (!s.notes) return;
  let moved = false;
  const notes: Record<string, Partial<ReadingSettings>> = {};
  for (const [path, v] of Object.entries(s.notes)) {
    const next = path === from ? to : path.startsWith(`${from}/`) ? to + path.slice(from.length) : path;
    if (next !== path) moved = true;
    notes[next] = v;
  }
  if (moved) write({ ...s, notes });
}

/** Has the person ever changed a reading option? (App skips loading this module until then.) */
export function hasReadingSettings(): boolean {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

export const READING_VARS = ["--reading-font", "--reading-size", "--reading-line-height", "--reading-width", "--reading-word-spacing", "--reading-letter-spacing"] as const;

/** The CSS custom properties for `s` (`null` = leave the stylesheet's value). */
export function readingVars(s: ReadingSettings): Record<(typeof READING_VARS)[number], string | null> {
  const hebrew = HEBREW_FONTS.find((f) => f.id === s.font);
  const stack: string[] = [];
  if (s.dyslexiaLatin) stack.push(`"${DYSLEXIA_FONT.family}"`);
  if (hebrew) stack.push(`"${hebrew.family}"`);
  const fallback = hebrew?.serif === false ? "var(--font-sans)" : "var(--font-serif)";
  return {
    "--reading-font": stack.length ? `${stack.join(", ")}, ${fallback}` : null,
    "--reading-size": s.size === DEFAULT_READING.size ? null : `${s.size}px`,
    // Spaced Hebrew needs room between the lines for nikud above and below.
    "--reading-line-height": s.spacedHebrew ? String(Math.max(s.lineHeight, 1.9)) : s.lineHeight === DEFAULT_READING.lineHeight ? null : String(s.lineHeight),
    "--reading-width": s.width === DEFAULT_READING.width ? null : `${s.width}ch`,
    "--reading-word-spacing": s.spacedHebrew ? "0.18em" : null,
    "--reading-letter-spacing": s.spacedHebrew ? "0.02em" : null,
  };
}

/** Write `s` to `root` and download the faces it needs. Resolves when they are ready. */
export async function applyReading(s: ReadingSettings, root: HTMLElement = document.documentElement): Promise<boolean> {
  const vars = readingVars(s);
  for (const name of READING_VARS) {
    const v = vars[name];
    if (v === null) root.style.removeProperty(name);
    else root.style.setProperty(name, v);
  }
  const wanted = [HEBREW_FONTS.find((f) => f.id === s.font), s.dyslexiaLatin ? DYSLEXIA_FONT : undefined].filter((f): f is ReadingFont => !!f);
  const ok = await Promise.all(wanted.map((f) => loadReadingFont(f)));
  return ok.every(Boolean);
}
