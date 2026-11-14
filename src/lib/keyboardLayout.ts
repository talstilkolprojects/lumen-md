/**
 * Hebrew keyboard layout (plan W2.8). Two everyday problems:
 *
 *  1. Text typed with the wrong layout on: `akuo` meant `שלום`, `יקךךם`
 *     meant `hello`. `wrongLayoutVariant()` gives the other reading, so the
 *     palette and search can offer both.
 *  2. Shortcuts with the Hebrew layout on: Ctrl+K arrives as `key: "ל"`.
 *     `shortcutKey()` reads the physical key (`KeyboardEvent.code`), so
 *     Ctrl+K is Ctrl+K in any layout.
 *
 * The table is the Israeli standard layout (SI 1452) on a US keyboard.
 * Small and dependency-free: it is part of the startup bundle.
 */

/** US key → the Hebrew character on that key (SI 1452). */
const LATIN_TO_HEBREW: Readonly<Record<string, string>> = {
  q: "/", w: "'", e: "ק", r: "ר", t: "א", y: "ט", u: "ו", i: "ן", o: "ם", p: "פ",
  a: "ש", s: "ד", d: "ג", f: "כ", g: "ע", h: "י", j: "ח", k: "ל", l: "ך", ";": "ף", "'": ",",
  z: "ז", x: "ס", c: "ב", v: "ה", b: "נ", n: "מ", m: "צ", ",": "ת", ".": "ץ", "/": ".",
};

const HEBREW_TO_LATIN: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(LATIN_TO_HEBREW).map(([k, v]) => [v, k]));

const HEBREW_LETTER = /[א-ת]/;
const LATIN_LETTER = /[a-z]/i;

/** Text typed with the English layout, read as the Hebrew layout: `akuo` → `שלום`. */
export function toHebrewLayout(s: string): string {
  return [...s].map((c) => LATIN_TO_HEBREW[c.toLowerCase()] ?? c).join("");
}

/** Text typed with the Hebrew layout, read as the English layout: `יקךךם` → `hello`. */
export function toLatinLayout(s: string): string {
  return [...s].map((c) => HEBREW_TO_LATIN[c] ?? c).join("");
}

/**
 * The same keystrokes in the other layout, when that reading is plausible:
 * Latin-only text → Hebrew, Hebrew-only text → Latin. `null` for mixed
 * text, text with neither, or when nothing changes.
 */
export function wrongLayoutVariant(query: string): string | null {
  const q = query.trim();
  if (!q) return null;
  const he = HEBREW_LETTER.test(q);
  const la = LATIN_LETTER.test(q);
  if (la && !he) {
    const v = toHebrewLayout(q);
    return HEBREW_LETTER.test(v) && v !== q ? v : null;
  }
  if (he && !la) {
    const v = toLatinLayout(q);
    return LATIN_LETTER.test(v) && v !== q ? v : null;
  }
  return null;
}

/** `KeyboardEvent.code` → the key's name on a US keyboard (`KeyK` → `k`, `Digit1` → `1`, `Slash` → `/`). */
const CODE_PUNCT: Readonly<Record<string, string>> = {
  Slash: "/", Backslash: "\\", Period: ".", Comma: ",", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]",
  Minus: "-", Equal: "=", Backquote: "`", Space: " ",
};

export function codeToKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  return CODE_PUNCT[code] ?? null;
}

interface KeyLike {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * The key of a shortcut, lowercase, independent of the layout: from `code`
 * when the layout gives a non-Latin character (Hebrew `ל` on the K key) —
 * from `key` otherwise, so Dvorak / AZERTY users keep their letters.
 */
export function shortcutKey(e: KeyLike): string {
  const k = e.key ?? "";
  // The Hebrew layout puts ASCII punctuation on letter keys too (Q types "/",
  // the / key types "."): when `key` is what the Hebrew layout gives on this
  // physical key, the physical key is meant.
  const physical = e.code ? codeToKey(e.code) : null;
  if (physical && k !== physical && LATIN_TO_HEBREW[physical] === k) return physical;
  if (k.length === 1 && /[\x20-\x7E]/.test(k)) return k.toLowerCase();
  if (k.length === 1 || k === "Dead" || k === "Unidentified" || k === "Process") {
    if (physical) return physical;
  }
  return k.length === 1 ? k.toLowerCase() : k;
}

/**
 * Does the event match `combo`? `Mod` is ⌘ or Ctrl, `Ctrl` is Ctrl only,
 * the key is layout-independent: `matchShortcut(e, "Mod+Shift+F")`, `"Ctrl+Space"`.
 */
export function matchShortcut(e: KeyLike, combo: string): boolean {
  const parts = combo.split("+").map((p) => p.trim().toLowerCase());
  const last = parts.pop() ?? "";
  const key = last === "space" ? " " : last;
  const want = new Set(parts);
  const mod = !!(e.metaKey || e.ctrlKey);
  if ((want.has("mod") || want.has("ctrl")) !== mod) return false;
  if (want.has("ctrl") && !e.ctrlKey) return false;
  if (want.has("shift") !== !!e.shiftKey) return false;
  if (want.has("alt") !== !!e.altKey) return false;
  const got = shortcutKey(e);
  // A named key (F1, Escape) compares without case: the combo is lower-cased above.
  return got === key || (got.length > 1 && got.toLowerCase() === key);
}

/* ─── Which layout is active, for showing shortcuts ──────────────────── */

let active: "he" | "latin" | null = null;

/** Remember the layout from what was typed (a Hebrew letter → Hebrew). */
export function noteTypedKey(key: string): void {
  if (key.length !== 1) return;
  if (HEBREW_LETTER.test(key)) active = "he";
  else if (LATIN_LETTER.test(key)) active = "latin";
}

/** The active layout: what was last typed, else the UI language. */
export function activeLayout(uiLocale: string): "he" | "latin" {
  return active ?? (uiLocale === "he" ? "he" : "latin");
}

/** `K` → `ל`: the Hebrew character on the same key, for "Ctrl+K (ל)". Null when there is none. */
export function hebrewOnKey(key: string): string | null {
  const c = LATIN_TO_HEBREW[key.toLowerCase()];
  return c && HEBREW_LETTER.test(c) ? c : null;
}

/** For tests. */
export function resetLayoutMemory(): void {
  active = null;
}
