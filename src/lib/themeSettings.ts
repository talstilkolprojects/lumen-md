/**
 * Theme customisation model (LAUNCH-READINESS polish #9).
 *
 * The app's colours are CSS custom properties holding bare HSL triplets
 * (`--bg: 0 0% 100%`, consumed as `hsl(var(--bg))`), with a light set on
 * `:root` and a dark set on `.dark` (see `src/index.css`). A theme here is:
 *
 *   - a colour preset — `default` leaves the stylesheet palette alone;
 *     every other preset ships an explicit light + dark palette that is
 *     written as inline custom properties on `<html>` (inline wins over
 *     both `:root` and `.dark`);
 *   - an optional accent override (hex);
 *   - typography + layout: editor font family, size, line height and the
 *     content measure shared by the editor and the preview.
 *
 * Everything in this file is pure (DOM writes are isolated in
 * `applyThemeSettings`, which takes the target element) so validation,
 * variable generation and contrast guarantees are unit-testable.
 */

import { contrastRatio, hexToHslTriplet, isHexColor, normalizeHex, bestTextOn } from "./contrast";

export type PresetId = "default" | "sepia" | "nord" | "highContrast" | "hebrew";
export type FontChoice = "system" | "serif" | "mono" | "hebrew" | "custom";

export interface ThemeSettings {
  preset: PresetId;
  /** Hex accent override; `null` = use the preset's accent. */
  accent: string | null;
  fontFamily: FontChoice;
  /** Font family name used when `fontFamily === "custom"`. */
  customFont: string;
  /** Editor font size in px. */
  fontSize: number;
  /** Editor line height (unitless). */
  lineHeight: number;
  /** Content measure in `ch`, shared by editor and preview. */
  contentWidth: number;
}

export interface Palette {
  bg: string;
  bgSubtle: string;
  bgMuted: string;
  bgInset: string;
  fg: string;
  fgSubtle: string;
  fgMuted: string;
  border: string;
  borderStrong: string;
  accent: string;
  accentFg: string;
}

export interface ThemePreset {
  id: PresetId;
  /** `null` = keep the stylesheet palette (the built-in light/dark look). */
  light: Palette | null;
  dark: Palette | null;
}

export const PRESET_IDS: readonly PresetId[] = ["default", "sepia", "nord", "highContrast", "hebrew"];
export const FONT_CHOICES: readonly FontChoice[] = ["system", "serif", "mono", "hebrew", "custom"];

export const LIMITS = {
  fontSize: { min: 11, max: 24, step: 1 },
  lineHeight: { min: 1.2, max: 2.2, step: 0.05 },
  contentWidth: { min: 50, max: 140, step: 2 },
  customFontMaxLength: 64,
  importMaxBytes: 8 * 1024,
} as const;

export const DEFAULT_THEME_SETTINGS: Readonly<ThemeSettings> = Object.freeze({
  preset: "default",
  accent: null,
  fontFamily: "mono",
  customFont: "",
  fontSize: 14,
  lineHeight: 1.65,
  contentWidth: 80,
});

export const PRESETS: Record<PresetId, ThemePreset> = {
  default: { id: "default", light: null, dark: null },
  sepia: {
    id: "sepia",
    light: {
      bg: "#f4ecd8",
      bgSubtle: "#efe5cd",
      bgMuted: "#e8dcc0",
      bgInset: "#e0d2b2",
      fg: "#3b2f22",
      fgSubtle: "#55412d",
      fgMuted: "#6b5640",
      border: "#d8c8a6",
      borderStrong: "#c4b08a",
      accent: "#8a4b16",
      accentFg: "#ffffff",
    },
    dark: {
      bg: "#1f1a14",
      bgSubtle: "#241e17",
      bgMuted: "#2b241c",
      bgInset: "#342b21",
      fg: "#ecdfc6",
      fgSubtle: "#d2c2a3",
      fgMuted: "#ab9a7d",
      border: "#3a3026",
      borderStrong: "#4d4032",
      accent: "#e0a96d",
      accentFg: "#1f1a14",
    },
  },
  nord: {
    id: "nord",
    light: {
      bg: "#eceff4",
      bgSubtle: "#e5e9f0",
      bgMuted: "#dde2ea",
      bgInset: "#d8dee9",
      fg: "#2e3440",
      fgSubtle: "#3b4252",
      fgMuted: "#4c566a",
      border: "#d0d6e0",
      borderStrong: "#b8c0cc",
      accent: "#4a6b94",
      accentFg: "#ffffff",
    },
    dark: {
      bg: "#2e3440",
      bgSubtle: "#323845",
      bgMuted: "#3b4252",
      bgInset: "#434c5e",
      fg: "#eceff4",
      fgSubtle: "#d8dee9",
      fgMuted: "#b2bac9",
      border: "#3b4252",
      borderStrong: "#4c566a",
      accent: "#88c0d0",
      accentFg: "#2e3440",
    },
  },
  // WCAG: body text and muted text ≥ 7:1 (AAA), borders ≥ 3:1 (AA non-text),
  // accent ≥ 4.5:1 against the background. Enforced by themeSettings.test.ts.
  highContrast: {
    id: "highContrast",
    light: {
      bg: "#ffffff",
      bgSubtle: "#f7f7f7",
      bgMuted: "#efefef",
      bgInset: "#e4e4e4",
      fg: "#000000",
      fgSubtle: "#1a1a1a",
      fgMuted: "#383838",
      border: "#6b6b6b",
      borderStrong: "#3d3d3d",
      accent: "#0040c0",
      accentFg: "#ffffff",
    },
    dark: {
      bg: "#000000",
      bgSubtle: "#0a0a0a",
      bgMuted: "#141414",
      bgInset: "#1f1f1f",
      fg: "#ffffff",
      fgSubtle: "#f0f0f0",
      fgMuted: "#d0d0d0",
      border: "#8a8a8a",
      borderStrong: "#c0c0c0",
      accent: "#ffd60a",
      accentFg: "#000000",
    },
  },
  // "כתב" (W1.21): paper and ink for long Hebrew reading and writing — a
  // Hebrew serif with room between the lines (PRESET_TYPOGRAPHY below).
  hebrew: {
    id: "hebrew",
    light: {
      bg: "#fbf8f1",
      bgSubtle: "#f5f0e4",
      bgMuted: "#ede6d6",
      bgInset: "#e4dbc7",
      fg: "#1e1b16",
      fgSubtle: "#35302a",
      fgMuted: "#5a5247",
      border: "#ddd3be",
      borderStrong: "#b9ab8e",
      accent: "#1f4e8c",
      accentFg: "#ffffff",
    },
    dark: {
      bg: "#17181c",
      bgSubtle: "#1c1d22",
      bgMuted: "#24262c",
      bgInset: "#2d2f36",
      fg: "#ece6da",
      fgSubtle: "#d6cfc1",
      fgMuted: "#aaa294",
      border: "#33353d",
      borderStrong: "#4a4c55",
      accent: "#8fb6ea",
      accentFg: "#17181c",
    },
  },
};

/**
 * Typography a preset brings with it (applied when the preset is chosen;
 * the user can change it after). Only "כתב" has one.
 */
export const PRESET_TYPOGRAPHY: Partial<Record<PresetId, Pick<ThemeSettings, "fontFamily" | "fontSize" | "lineHeight" | "contentWidth">>> = {
  hebrew: { fontFamily: "hebrew", fontSize: 16, lineHeight: 1.85, contentWidth: 70 },
};

const FONT_STACKS: Record<Exclude<FontChoice, "custom">, string> = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Helvetica Neue", Arial, sans-serif',
  serif: '"Source Serif 4", "Iowan Old Style", "Apple Garamond", Baskerville, ui-serif, serif',
  mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  // Hebrew serifs that ship with the systems (no download), then Hebrew-capable sans.
  hebrew: '"Frank Ruehl CLM", "Frank Ruhl Libre", "David CLM", "David", "Noto Serif Hebrew", "Times New Roman", "Arial Hebrew", serif',
};

/**
 * Font family names: letters (any script), digits, spaces, `-` and `_`.
 * Quotes, semicolons, braces, commas, parentheses etc. are rejected so the
 * value can be dropped into a CSS custom property without any escaping.
 */
const CUSTOM_FONT_RE = /^[\p{L}\p{N} _-]+$/u;

export function isValidCustomFont(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.trim().length > 0 &&
    name.length <= LIMITS.customFontMaxLength &&
    CUSTOM_FONT_RE.test(name)
  );
}

export function fontStackFor(s: Pick<ThemeSettings, "fontFamily" | "customFont">): string {
  if (s.fontFamily === "custom") {
    return isValidCustomFont(s.customFont)
      ? `"${s.customFont.trim()}", ${FONT_STACKS.mono}`
      : FONT_STACKS.mono;
  }
  return FONT_STACKS[s.fontFamily];
}

/** The palette for `mode` after applying the accent override (or `null`). */
export function resolvePalette(s: ThemeSettings, dark: boolean): Partial<Palette> | null {
  const base = PRESETS[s.preset][dark ? "dark" : "light"];
  if (!base && !s.accent) return null;
  const out: Partial<Palette> = base ? { ...base } : {};
  if (s.accent) {
    out.accent = normalizeHex(s.accent);
    out.accentFg = bestTextOn(out.accent);
  }
  return out;
}

const PALETTE_VARS: Record<keyof Palette, string> = {
  bg: "--bg",
  bgSubtle: "--bg-subtle",
  bgMuted: "--bg-muted",
  bgInset: "--bg-inset",
  fg: "--fg",
  fgSubtle: "--fg-subtle",
  fgMuted: "--fg-muted",
  border: "--border",
  borderStrong: "--border-strong",
  accent: "--accent",
  accentFg: "--accent-fg",
};

/** Every custom property this module may write — used to clear them. */
export const MANAGED_VARS: readonly string[] = [
  ...Object.values(PALETTE_VARS),
  "--editor-font",
  "--editor-font-size",
  "--editor-line-height",
  "--content-width",
  "--preview-width",
  "--font-serif",
  "--preview-line-height",
];

/** CSS custom properties for `settings` in the given colour mode. */
export function cssVariablesFor(s: ThemeSettings, dark: boolean): Record<string, string> {
  const vars: Record<string, string> = {
    "--editor-font": fontStackFor(s),
    "--editor-font-size": `${s.fontSize}px`,
    "--editor-line-height": String(s.lineHeight),
    "--content-width": `${s.contentWidth}ch`,
    // The preview's serif body is wider per `ch` than the mono editor, so
    // keep the stylesheet's 80ch : 72ch editor : preview ratio.
    "--preview-width": `${Math.round(s.contentWidth * 0.9)}ch`,
  };
  // Hebrew typography reaches the preview too: its body font and line spacing.
  if (s.fontFamily === "hebrew") {
    vars["--font-serif"] = FONT_STACKS.hebrew;
    vars["--preview-line-height"] = String(Math.max(1.7, s.lineHeight));
  }
  const palette = resolvePalette(s, dark);
  if (palette) {
    for (const [k, hex] of Object.entries(palette) as Array<[keyof Palette, string]>) {
      vars[PALETTE_VARS[k]] = hexToHslTriplet(hex);
    }
  }
  return vars;
}

/**
 * Write the theme to `root` (normally `document.documentElement`). Managed
 * variables not produced for this theme are removed, so switching back to
 * the default preset restores the stylesheet palette.
 */
export function applyThemeSettings(
  s: ThemeSettings,
  root: HTMLElement,
  dark = root.classList.contains("dark"),
): void {
  const vars = cssVariablesFor(s, dark);
  for (const name of MANAGED_VARS) {
    if (name in vars) root.style.setProperty(name, vars[name]);
    else root.style.removeProperty(name);
  }
  root.dataset.themePreset = s.preset;
}

// ── Contrast report ────────────────────────────────────────────────────

export interface ContrastCheck {
  id: "text" | "muted" | "accent" | "onAccent";
  ratio: number;
  /** Minimum ratio for WCAG AA in this role. */
  required: number;
  pass: boolean;
}

/** WCAG AA checks (text 4.5:1, accent as a UI component 3:1) for a palette. */
export function contrastReport(palette: Palette): ContrastCheck[] {
  const checks: Array<Omit<ContrastCheck, "pass">> = [
    { id: "text", ratio: contrastRatio(palette.fg, palette.bg), required: 4.5 },
    { id: "muted", ratio: contrastRatio(palette.fgMuted, palette.bg), required: 4.5 },
    { id: "accent", ratio: contrastRatio(palette.accent, palette.bg), required: 3 },
    { id: "onAccent", ratio: contrastRatio(palette.accentFg, palette.accent), required: 4.5 },
  ];
  return checks.map((c) => ({ ...c, pass: c.ratio >= c.required }));
}

/** Hex equivalents of the stylesheet palette in src/index.css (for reports). */
export const STYLESHEET_PALETTE: { light: Palette; dark: Palette } = {
  light: {
    bg: "#ffffff",
    bgSubtle: "#f9fafb",
    bgMuted: "#f1f2f4",
    bgInset: "#e8eaed",
    fg: "#151923",
    fgSubtle: "#4a4f59",
    fgMuted: "#6c727f",
    border: "#dcdfe4",
    borderStrong: "#c0c4ce",
    accent: "#7859f8",
    accentFg: "#ffffff",
  },
  dark: {
    bg: "#0e1016",
    bgSubtle: "#12151c",
    bgMuted: "#191c24",
    bgInset: "#22262f",
    fg: "#e8eaee",
    fgSubtle: "#b9bdc6",
    fgMuted: "#8b919c",
    border: "#272b34",
    borderStrong: "#393e4c",
    accent: "#886cf9",
    accentFg: "#0e1016",
  },
};

export function effectivePalette(s: ThemeSettings, dark: boolean): Palette {
  const base = PRESETS[s.preset][dark ? "dark" : "light"] ?? STYLESHEET_PALETTE[dark ? "dark" : "light"];
  const resolved = resolvePalette(s, dark) ?? {};
  return { ...base, ...resolved };
}

// ── Validation / import / export ───────────────────────────────────────

export const THEME_FILE_VERSION = 1;
const FILE_KEYS = [
  "lumenTheme",
  "preset",
  "accent",
  "fontFamily",
  "customFont",
  "fontSize",
  "lineHeight",
  "contentWidth",
] as const;

export type ThemeImportError =
  | "tooLarge"
  | "notJson"
  | "notObject"
  | "badVersion"
  | "unknownKey"
  | "invalidColor"
  | "invalidValue";

export type ThemeImportResult =
  | { ok: true; settings: ThemeSettings }
  | { ok: false; error: ThemeImportError; key?: string };

function inRange(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}

/**
 * Strictly validate an already-parsed theme object. Unknown keys, a wrong
 * version marker, malformed colours or out-of-range numbers are rejected
 * (no silent coercion). Omitted keys take their default value.
 */
export function validateThemeObject(input: unknown): ThemeImportResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "notObject" };
  }
  const obj = input as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(FILE_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: "unknownKey", key };
    }
  }
  if (obj.lumenTheme !== THEME_FILE_VERSION) {
    return { ok: false, error: "badVersion", key: "lumenTheme" };
  }
  const out: ThemeSettings = { ...DEFAULT_THEME_SETTINGS };

  if ("preset" in obj) {
    if (!PRESET_IDS.includes(obj.preset as PresetId)) return { ok: false, error: "invalidValue", key: "preset" };
    out.preset = obj.preset as PresetId;
  }
  if ("accent" in obj) {
    if (obj.accent === null) out.accent = null;
    else if (isHexColor(obj.accent)) out.accent = normalizeHex(obj.accent);
    else return { ok: false, error: "invalidColor", key: "accent" };
  }
  if ("fontFamily" in obj) {
    if (!FONT_CHOICES.includes(obj.fontFamily as FontChoice)) {
      return { ok: false, error: "invalidValue", key: "fontFamily" };
    }
    out.fontFamily = obj.fontFamily as FontChoice;
  }
  if ("customFont" in obj) {
    if (obj.customFont === "") out.customFont = "";
    else if (isValidCustomFont(obj.customFont)) out.customFont = obj.customFont.trim();
    else return { ok: false, error: "invalidValue", key: "customFont" };
  }
  if (out.fontFamily === "custom" && !isValidCustomFont(out.customFont)) {
    return { ok: false, error: "invalidValue", key: "customFont" };
  }
  if ("fontSize" in obj) {
    if (!inRange(obj.fontSize, LIMITS.fontSize.min, LIMITS.fontSize.max)) {
      return { ok: false, error: "invalidValue", key: "fontSize" };
    }
    out.fontSize = obj.fontSize;
  }
  if ("lineHeight" in obj) {
    if (!inRange(obj.lineHeight, LIMITS.lineHeight.min, LIMITS.lineHeight.max)) {
      return { ok: false, error: "invalidValue", key: "lineHeight" };
    }
    out.lineHeight = obj.lineHeight;
  }
  if ("contentWidth" in obj) {
    if (!inRange(obj.contentWidth, LIMITS.contentWidth.min, LIMITS.contentWidth.max)) {
      return { ok: false, error: "invalidValue", key: "contentWidth" };
    }
    out.contentWidth = obj.contentWidth;
  }
  return { ok: true, settings: out };
}

/** Parse + validate a theme JSON string (as produced by `exportThemeJson`). */
export function parseThemeJson(text: string): ThemeImportResult {
  if (new TextEncoder().encode(text).length > LIMITS.importMaxBytes) {
    return { ok: false, error: "tooLarge" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "notJson" };
  }
  return validateThemeObject(parsed);
}

export function exportThemeJson(s: ThemeSettings): string {
  return `${JSON.stringify(
    {
      lumenTheme: THEME_FILE_VERSION,
      preset: s.preset,
      accent: s.accent,
      fontFamily: s.fontFamily,
      customFont: s.customFont,
      fontSize: s.fontSize,
      lineHeight: s.lineHeight,
      contentWidth: s.contentWidth,
    },
    null,
    2,
  )}\n`;
}

/**
 * Lenient variant for persisted state (localStorage can be stale or
 * hand-edited): each invalid field falls back to its default instead of
 * rejecting the whole object.
 */
export function sanitizeThemeSettings(input: unknown): ThemeSettings {
  const out: ThemeSettings = { ...DEFAULT_THEME_SETTINGS };
  if (typeof input !== "object" || input === null) return out;
  const o = input as Record<string, unknown>;
  if (PRESET_IDS.includes(o.preset as PresetId)) out.preset = o.preset as PresetId;
  if (isHexColor(o.accent)) out.accent = normalizeHex(o.accent);
  if (FONT_CHOICES.includes(o.fontFamily as FontChoice)) out.fontFamily = o.fontFamily as FontChoice;
  if (isValidCustomFont(o.customFont)) out.customFont = o.customFont.trim();
  if (out.fontFamily === "custom" && !out.customFont) out.fontFamily = DEFAULT_THEME_SETTINGS.fontFamily;
  if (inRange(o.fontSize, LIMITS.fontSize.min, LIMITS.fontSize.max)) out.fontSize = o.fontSize;
  if (inRange(o.lineHeight, LIMITS.lineHeight.min, LIMITS.lineHeight.max)) out.lineHeight = o.lineHeight;
  if (inRange(o.contentWidth, LIMITS.contentWidth.min, LIMITS.contentWidth.max)) out.contentWidth = o.contentWidth;
  return out;
}
