/**
 * Reading aids (plan W5.6): a dyslexia-friendly layout for the preview and
 * the editor — face, letter / word / line spacing, a line-focus highlight
 * and a tinted page — and the read-aloud speed. Nothing here changes a note.
 *
 * Why these defaults (sources in docs/…/editor/reading-aids.md):
 *  - Extra letter and word spacing is the aid with the best evidence for
 *    dyslexic readers (Zorzi et al., PNAS 2012, letter spacing; the British
 *    Dyslexia Association style guide asks for wide letter and word spacing
 *    and 1.5 line spacing). The defaults are the WCAG 2.2 SC 1.4.12 values
 *    (letter 0.12em, word 0.16em) with taller lines (1.8).
 *  - Off-white backgrounds (cream, pastel) are in the same guide; each tint
 *    keeps body text above 7:1 contrast in light and dark themes.
 *  - Face: a plain sans for Hebrew (Noto Sans Hebrew, OFL 1.1, every niqqud
 *    mark placed by the font) — no dedicated Hebrew dyslexia face with an
 *    open licence exists — and, for Latin text, OpenDyslexic (OFL 1.1) as an
 *    option rather than the default: studies found it no faster than a
 *    plain sans (Wery & Diliberto 2017; Kuster et al. 2018), but some readers
 *    prefer it.
 *
 * Settings live in localStorage (`lumen-reading-aids`). The faces are
 * downloaded from this app's own origin when chosen, never at startup.
 */

export type AidsFont = "app" | "notoSansHebrew" | "openDyslexic";
export type AidsTint = "none" | "cream" | "blue" | "green" | "gray";

export interface ReadingAids {
  /** The dyslexia-friendly layout on or off. */
  dyslexia: boolean;
  font: AidsFont;
  /** em */
  letterSpacing: number;
  /** em */
  wordSpacing: number;
  lineHeight: number;
  /** Highlight the line or paragraph being read. */
  lineFocus: boolean;
  tint: AidsTint;
  /** Read-aloud speed (SpeechSynthesisUtterance.rate). */
  rate: number;
}

export const AIDS_LIMITS = {
  letterSpacing: { min: 0, max: 0.35, step: 0.01 },
  wordSpacing: { min: 0, max: 1, step: 0.02 },
  lineHeight: { min: 1.4, max: 2.6, step: 0.05 },
  rate: { min: 0.5, max: 2, step: 0.05 },
} as const;

export const DEFAULT_AIDS: Readonly<ReadingAids> = Object.freeze({
  dyslexia: false,
  font: "notoSansHebrew",
  letterSpacing: 0.12,
  wordSpacing: 0.16,
  lineHeight: 1.8,
  lineFocus: true,
  tint: "cream",
  rate: 1,
});

export const AIDS_FONTS: readonly AidsFont[] = ["app", "notoSansHebrew", "openDyslexic"];
export const AIDS_TINTS: readonly AidsTint[] = ["none", "cream", "blue", "green", "gray"];

export const AIDS_KEY = "lumen-reading-aids";

const clamp = (n: unknown, { min, max }: { min: number; max: number }, d: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d);

/** Any stored value made valid. */
export function normalizeAids(v: unknown): ReadingAids {
  const s = (v && typeof v === "object" ? v : {}) as Partial<Record<keyof ReadingAids, unknown>>;
  const d = DEFAULT_AIDS;
  return {
    dyslexia: typeof s.dyslexia === "boolean" ? s.dyslexia : d.dyslexia,
    font: AIDS_FONTS.includes(s.font as AidsFont) ? (s.font as AidsFont) : d.font,
    letterSpacing: clamp(s.letterSpacing, AIDS_LIMITS.letterSpacing, d.letterSpacing),
    wordSpacing: clamp(s.wordSpacing, AIDS_LIMITS.wordSpacing, d.wordSpacing),
    lineHeight: clamp(s.lineHeight, AIDS_LIMITS.lineHeight, d.lineHeight),
    lineFocus: typeof s.lineFocus === "boolean" ? s.lineFocus : d.lineFocus,
    tint: AIDS_TINTS.includes(s.tint as AidsTint) ? (s.tint as AidsTint) : d.tint,
    rate: clamp(s.rate, AIDS_LIMITS.rate, d.rate),
  };
}

export function loadAids(): ReadingAids {
  try {
    const raw = localStorage.getItem(AIDS_KEY);
    return normalizeAids(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeAids(null);
  }
}

export function saveAids(a: ReadingAids): void {
  try {
    localStorage.setItem(AIDS_KEY, JSON.stringify(normalizeAids(a)));
  } catch {
    // why: storage is blocked or full (private mode, quota): the setting holds for this session only
    /* private mode: the aids last for this visit */
  }
}

interface FaceFile {
  path: string;
  weight: string;
  bytes: number;
}

/** The faces the aids can download (same files and family names as the reading options, plan W3.5). */
export const AIDS_FACES: Record<Exclude<AidsFont, "app">, { family: string; files: FaceFile[]; license: string; source: string }> = {
  notoSansHebrew: {
    family: "Lumen Noto Sans Hebrew",
    files: [{ path: "fonts/reading/noto-sans-hebrew.woff2", weight: "400 700", bytes: 28988 }],
    license: "fonts/reading/OFL-noto-sans-hebrew.txt",
    source: "https://github.com/notofonts/hebrew",
  },
  openDyslexic: {
    family: "Lumen OpenDyslexic",
    files: [
      { path: "fonts/reading/opendyslexic-400.woff2", weight: "400", bytes: 103336 },
      { path: "fonts/reading/opendyslexic-700.woff2", weight: "700", bytes: 108068 },
    ],
    license: "fonts/reading/OFL-opendyslexic.txt",
    source: "https://github.com/antijingoist/opendyslexic",
  },
};

/** The CSS font stack: OpenDyslexic has no Hebrew letters, so Hebrew falls through to Noto Sans Hebrew. */
export function fontStack(font: AidsFont): string {
  const app = "var(--font-sans, Heebo, Inter, system-ui, sans-serif)";
  if (font === "app") return app;
  if (font === "notoSansHebrew") return `"${AIDS_FACES.notoSansHebrew.family}", ${app}`;
  return `"${AIDS_FACES.openDyslexic.family}", "${AIDS_FACES.notoSansHebrew.family}", ${app}`;
}

/** The faces a font choice needs downloaded. */
export function facesFor(font: AidsFont): Array<keyof typeof AIDS_FACES> {
  if (font === "app") return [];
  return font === "openDyslexic" ? ["openDyslexic", "notoSansHebrew"] : ["notoSansHebrew"];
}

/** Background and line-focus colours per tint, light and dark (text contrast ≥ 7:1 on each, docs table). */
export const TINTS: Record<Exclude<AidsTint, "none">, { light: string; dark: string }> = {
  cream: { light: "#fbf5e6", dark: "#2b2618" },
  blue: { light: "#e8f1fb", dark: "#17222f" },
  green: { light: "#ebf5e9", dark: "#18261a" },
  gray: { light: "#efefef", dark: "#242424" },
};

/** The custom properties and attributes the aids put on <html>. */
export function aidsAttributes(a: ReadingAids): { attrs: Record<string, string | null>; vars: Record<string, string | null> } {
  if (!a.dyslexia) {
    return {
      attrs: { "data-reading-aids": null, "data-reading-tint": null, "data-reading-focus": null },
      vars: { "--ra-font": null, "--ra-letter": null, "--ra-word": null, "--ra-line": null, "--ra-bg-light": null, "--ra-bg-dark": null },
    };
  }
  const tint = a.tint === "none" ? null : TINTS[a.tint];
  return {
    attrs: { "data-reading-aids": "on", "data-reading-tint": tint ? a.tint : null, "data-reading-focus": a.lineFocus ? "on" : null },
    vars: {
      "--ra-font": fontStack(a.font),
      "--ra-letter": `${a.letterSpacing}em`,
      "--ra-word": `${a.wordSpacing}em`,
      "--ra-line": String(a.lineHeight),
      "--ra-bg-light": tint?.light ?? null,
      "--ra-bg-dark": tint?.dark ?? null,
    },
  };
}

/**
 * The stylesheet, injected once when the aids are first used (it is not in
 * the startup CSS). It applies to the preview and to the editor's text.
 */
export const AIDS_CSS = `
html[data-reading-aids] .prose-lumen,
html[data-reading-aids] .cm-editor .cm-content {
  font-family: var(--ra-font);
  letter-spacing: var(--ra-letter);
  word-spacing: var(--ra-word);
  line-height: var(--ra-line);
}
html[data-reading-aids] .prose-lumen :is(p, li, blockquote, td, th) { line-height: var(--ra-line); }
html[data-reading-tint] .prose-lumen,
html[data-reading-tint] .cm-editor { background-color: var(--ra-bg-light); }
html.dark[data-reading-tint] .prose-lumen,
html.dark[data-reading-tint] .cm-editor { background-color: var(--ra-bg-dark); }
html[data-reading-focus] .prose-lumen :is(p, li, h1, h2, h3, h4, h5, h6, blockquote, td):is(:hover, :focus-within) {
  background-color: rgba(250, 204, 21, 0.16);
  box-shadow: inset 3px 0 0 rgba(202, 138, 4, 0.9);
  border-radius: 2px;
}
html[dir="rtl"][data-reading-focus] .prose-lumen :is(p, li, h1, h2, h3, h4, h5, h6, blockquote, td):is(:hover, :focus-within) {
  box-shadow: inset -3px 0 0 rgba(202, 138, 4, 0.9);
}
html[data-reading-focus] .cm-editor .cm-activeLine {
  background-color: rgba(250, 204, 21, 0.18);
  box-shadow: inset 3px 0 0 rgba(202, 138, 4, 0.9);
}
@media (prefers-reduced-motion: no-preference) {
  html[data-reading-focus] .prose-lumen :is(p, li, blockquote, td) { transition: background-color 120ms; }
}
`;

function baseUrl(): string {
  // One name at a time (src/lib/publicEnv.ts): a whole import.meta.env inlines every VITE_* name.
  return (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
}

const loadingFaces = new Map<string, Promise<boolean>>();

/** Download (once) and register a face from this app's origin. False when the browser could not load it. */
export function loadAidsFace(id: keyof typeof AIDS_FACES, fonts: FontFaceSet | undefined = typeof document !== "undefined" ? document.fonts : undefined): Promise<boolean> {
  const face = AIDS_FACES[id];
  if (!fonts || typeof FontFace === "undefined") return Promise.resolve(false);
  const cached = loadingFaces.get(face.family);
  if (cached) return cached;
  const p = Promise.all(
    face.files.map(async (f) => {
      const ff = new FontFace(face.family, `url(${JSON.stringify(baseUrl() + f.path)}) format("woff2")`, { weight: f.weight, style: "normal", display: "swap" });
      await ff.load();
      fonts.add(ff);
    }),
  ).then(
    () => true,
    () => {
      loadingFaces.delete(face.family);
      return false;
    },
  );
  loadingFaces.set(face.family, p);
  return p;
}

/** Put the aids on the page (and their faces, downloaded on first use). */
export function applyAids(a: ReadingAids, doc: Document = document): void {
  if (a.dyslexia && !doc.getElementById("lumen-reading-aids-css")) {
    const style = doc.createElement("style");
    style.id = "lumen-reading-aids-css";
    style.textContent = AIDS_CSS;
    doc.head.appendChild(style);
  }
  const { attrs, vars } = aidsAttributes(a);
  const root = doc.documentElement;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null) root.removeAttribute(k);
    else root.setAttribute(k, v);
  }
  for (const [k, v] of Object.entries(vars)) {
    if (v === null) root.style.removeProperty(k);
    else root.style.setProperty(k, v);
  }
  if (a.dyslexia) for (const f of facesFor(a.font)) void loadAidsFace(f);
}

/** On startup, only when the person turned the aids on (src/main.tsx checks the key before importing this). */
export function applyStoredAids(): void {
  applyAids(loadAids());
}

/** Tests. */
export function __resetAidsFaces(): void {
  loadingFaces.clear();
}
