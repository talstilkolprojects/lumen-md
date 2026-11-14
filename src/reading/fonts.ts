/**
 * Reading fonts (plan W3.5). Hebrew faces that keep nikud in place, and a
 * dyslexia-friendly face for Latin text — every one under the SIL Open Font
 * License (public/fonts/reading/OFL-*.txt).
 *
 * None of them is in the startup bundle or the service worker's precache:
 * a face is downloaded the first time the person chooses it, from this
 * app's own origin (never a font service), then cached for offline use
 * (vite.config.ts, runtime cache "lumen-reading-fonts"). Heebo and Frank
 * Ruhl Libre are the app's own UI faces (src/fonts.ts): nothing to download.
 *
 * The Hebrew files are subsets (Hebrew with every nikud and cantillation
 * mark, presentation forms, Latin-1, punctuation; all OpenType layout
 * kept) made by scripts/reading-fonts.sh. OpenDyslexic has a Reserved Font
 * Name, so its files are the upstream ones, unchanged.
 */

export type ReadingFontId = "default" | "heebo" | "frankRuhl" | "notoSans" | "notoSerif" | "assistant" | "davidLibre";

export interface FontFile {
  /** Below public/, so the URL is `${BASE_URL}${path}`. */
  path: string;
  /** CSS font-weight: one value, or a range for a variable font. */
  weight: string;
  bytes: number;
}

export interface ReadingFont {
  id: ReadingFontId | "openDyslexic";
  /** The family name as its authors wrote it (brand names are not translated). */
  name: string;
  /** The family the page uses for it. */
  family: string;
  serif: boolean;
  /** Files to download; empty when the app already ships the face. */
  files: FontFile[];
  /** Upstream project, for the licence notice. */
  source: string;
  license: "OFL-1.1";
  licenseFile?: string;
}

const DIR = "fonts/reading/";

/** The Hebrew faces offered, in the order they are listed. */
export const HEBREW_FONTS: readonly ReadingFont[] = [
  { id: "heebo", name: "Heebo", family: "Heebo", serif: false, files: [], source: "https://github.com/OdedEzer/heebo", license: "OFL-1.1" },
  { id: "frankRuhl", name: "Frank Ruhl Libre", family: "Frank Ruhl Libre", serif: true, files: [], source: "https://github.com/fontef/frankruhllibre", license: "OFL-1.1" },
  {
    id: "notoSans",
    name: "Noto Sans Hebrew",
    family: "Lumen Noto Sans Hebrew",
    serif: false,
    files: [{ path: `${DIR}noto-sans-hebrew.woff2`, weight: "400 700", bytes: 28988 }],
    source: "https://github.com/notofonts/hebrew",
    license: "OFL-1.1",
    licenseFile: `${DIR}OFL-noto-sans-hebrew.txt`,
  },
  {
    id: "notoSerif",
    name: "Noto Serif Hebrew",
    family: "Lumen Noto Serif Hebrew",
    serif: true,
    files: [{ path: `${DIR}noto-serif-hebrew.woff2`, weight: "400 700", bytes: 32168 }],
    source: "https://github.com/notofonts/hebrew",
    license: "OFL-1.1",
    licenseFile: `${DIR}OFL-noto-serif-hebrew.txt`,
  },
  {
    id: "assistant",
    name: "Assistant",
    family: "Lumen Assistant",
    serif: false,
    files: [{ path: `${DIR}assistant.woff2`, weight: "400 700", bytes: 24840 }],
    source: "https://github.com/hafontia/Assistant",
    license: "OFL-1.1",
    licenseFile: `${DIR}OFL-assistant.txt`,
  },
  {
    id: "davidLibre",
    name: "David Libre",
    family: "Lumen David Libre",
    serif: true,
    files: [
      { path: `${DIR}david-libre-400.woff2`, weight: "400", bytes: 25024 },
      { path: `${DIR}david-libre-700.woff2`, weight: "700", bytes: 25492 },
    ],
    source: "https://github.com/meirsadan/david-libre",
    license: "OFL-1.1",
    licenseFile: `${DIR}OFL-david-libre.txt`,
  },
];

/** For Latin text, when the person turns on the dyslexia-friendly face. */
export const DYSLEXIA_FONT: ReadingFont = {
  id: "openDyslexic",
  name: "OpenDyslexic",
  family: "Lumen OpenDyslexic",
  serif: false,
  files: [
    { path: `${DIR}opendyslexic-400.woff2`, weight: "400", bytes: 103336 },
    { path: `${DIR}opendyslexic-700.woff2`, weight: "700", bytes: 108068 },
  ],
  source: "https://github.com/antijingoist/opendyslexic",
  license: "OFL-1.1",
  licenseFile: `${DIR}OFL-opendyslexic.txt`,
};

export const ALL_READING_FONTS: readonly ReadingFont[] = [...HEBREW_FONTS, DYSLEXIA_FONT];

export function readingFont(id: string): ReadingFont | undefined {
  return ALL_READING_FONTS.find((f) => f.id === id);
}

/** Bytes to download for a face (0 when the app already has it). */
export function downloadBytes(f: ReadingFont): number {
  return f.files.reduce((n, x) => n + x.bytes, 0);
}

function baseUrl(): string {
  const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
  return env?.BASE_URL ?? "/";
}

/** The same-origin URL of a font file. */
export function fontUrl(file: FontFile): string {
  return `${baseUrl()}${file.path}`;
}

const loading = new Map<string, Promise<boolean>>();

/**
 * Download (once) and register a reading face. Resolves true when it is
 * ready, false when the browser could not load it (the page keeps its
 * fallback font). Never fetches anything for a face the app ships.
 */
export function loadReadingFont(f: ReadingFont, fonts: FontFaceSet | undefined = typeof document !== "undefined" ? document.fonts : undefined): Promise<boolean> {
  if (!f.files.length || !fonts || typeof FontFace === "undefined") return Promise.resolve(true);
  const cached = loading.get(f.family);
  if (cached) return cached;
  const p = Promise.all(
    f.files.map(async (file) => {
      const face = new FontFace(f.family, `url(${JSON.stringify(fontUrl(file))}) format("woff2")`, { weight: file.weight, style: "normal", display: "swap" });
      await face.load();
      fonts.add(face);
    }),
  ).then(
    () => true,
    () => {
      loading.delete(f.family);
      return false;
    },
  );
  loading.set(f.family, p);
  return p;
}

/** Test seam: forget what was loaded. */
export function __resetReadingFonts(): void {
  loading.clear();
}
