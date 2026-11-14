/**
 * Typing a formula with the Hebrew layout on (plan W5.14): the Latin
 * character of the same physical key, so $x^2$ needs no layout switch.
 * The table is the Israeli standard layout (SI 1452) on a US keyboard, the
 * same one W2.8's lib/keyboardLayout uses for shortcuts. Only a key press
 * that produced exactly the Hebrew layout's character is translated, so
 * other layouts (AZERTY, Russian…) are never touched.
 */

/** US key → the character the Hebrew layout (SI 1452) puts on it. */
const HEBREW_ON_KEY: Readonly<Record<string, string>> = {
  q: "/", w: "'", e: "ק", r: "ר", t: "א", y: "ט", u: "ו", i: "ן", o: "ם", p: "פ",
  a: "ש", s: "ד", d: "ג", f: "כ", g: "ע", h: "י", j: "ח", k: "ל", l: "ך", ";": "ף", "'": ",",
  z: "ז", x: "ס", c: "ב", v: "ה", b: "נ", n: "מ", m: "צ", ",": "ת", ".": "ץ", "/": ".",
};
const CODE_TO_US: Readonly<Record<string, string>> = { Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/" };

/**
 * The Latin character for a key typed with the Hebrew layout, or null when
 * the key press is not one: `{ code: "KeyX", key: "ס" }` → "x".
 */
export function latinForHebrewKey(e: { code?: string; key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): string | null {
  if (e.ctrlKey || e.metaKey || e.altKey || !e.code) return null;
  const letter = /^Key([A-Z])$/.exec(e.code);
  const us = letter ? letter[1].toLowerCase() : CODE_TO_US[e.code];
  if (!us || HEBREW_ON_KEY[us] !== e.key) return null;
  return letter && e.shiftKey ? us.toUpperCase() : us;
}

