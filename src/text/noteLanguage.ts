/**
 * A note's language tag (plan W7.9): `lang:` (or `language:`) in its front
 * matter, as a BCP 47 tag, else Yiddish when its Hebrew-script prose reads
 * as Yiddish. The tag goes on the editor, the preview and the HTML export
 * (`lang` attribute), so screen readers, hyphenation and fonts follow it.
 *
 * Direction is not decided here: it comes from each block's own text
 * (editor/bidi.ts, renderer/rehypeDirAuto.ts), which is already right for
 * Yiddish (Hebrew letters: right to left) and Ladino (Latin letters left to
 * right, Hebrew letters right to left). `lad` alone is resolved to
 * `lad-Latn` or `lad-Hebr` by the note's script.
 */
import { isYiddishText } from "./yiddish";
import { ladinoScript } from "./ladino";

export interface NoteLanguage {
  /** BCP 47, e.g. "yi", "lad-Latn", "lad-Hebr", "he". */
  tag: string;
  /** The base direction a note in this language and script has. */
  dir: "ltr" | "rtl";
  /** Where the tag came from. */
  source: "frontmatter" | "detected";
}

/** The languages this module knows, with their script's direction. */
export const JEWISH_LANGUAGES: Readonly<Record<string, { dir: "ltr" | "rtl"; script: "Hebr" | "Latn"; hebrewFont: boolean }>> = {
  yi: { dir: "rtl", script: "Hebr", hebrewFont: true },
  "lad-Latn": { dir: "ltr", script: "Latn", hebrewFont: false },
  "lad-Hebr": { dir: "rtl", script: "Hebr", hebrewFont: true },
};

const BCP47 = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/;

/** The front matter's text (between the fences), or null. */
function frontmatter(doc: string): string | null {
  if (!doc.startsWith("---")) return null;
  const end = doc.indexOf("\n---", 3);
  return end < 0 ? null : doc.slice(3, end);
}

/** Canonical case for a tag: language lower, script title, region upper ("LAD-hebr" → "lad-Hebr"). */
export function canonicalTag(raw: string): string | null {
  const parts = raw.trim().replace(/_/g, "-").split("-");
  if (!parts[0]) return null;
  const out = [parts[0].toLowerCase()];
  for (const p of parts.slice(1)) out.push(p.length === 4 ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p.length === 2 ? p.toUpperCase() : p);
  const tag = out.join("-");
  return BCP47.test(tag) ? tag : null;
}

/** The note's body without its front matter. */
function body(doc: string): string {
  const fm = frontmatter(doc);
  return fm === null ? doc : doc.slice(fm.length + 7);
}

/** Hebrew-script prose of the first part of a note (code and links left out). */
function hebrewProse(doc: string): string {
  return body(doc)
    .slice(0, 4000)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\]\([^)]*\)/g, " ");
}

export function noteLanguage(doc: string): NoteLanguage | null {
  const fm = frontmatter(doc);
  const m = fm === null ? null : /^(?:lang|language):\s*["']?([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,4}){0,2})["']?\s*$/m.exec(fm);
  if (m) {
    let tag = canonicalTag(m[1]);
    if (tag === "lad") tag = ladinoScript(body(doc)) === "hebrew" ? "lad-Hebr" : "lad-Latn";
    if (tag) {
      const known = JEWISH_LANGUAGES[tag];
      const dir = known?.dir ?? (/^(he|yi|ar|fa|ur|ps|sd|ug|dv|syr|lad-Hebr)/.test(tag) || /-(Hebr|Arab)$/.test(tag) ? "rtl" : "ltr");
      return { tag, dir, source: "frontmatter" };
    }
  }
  const prose = hebrewProse(doc);
  if (/[א-ת]/.test(prose) && isYiddishText(prose)) return { tag: "yi", dir: "rtl", source: "detected" };
  return null;
}

/** Does this tag want the bundled Hebrew face with full pointing (אַ אָ פֿ)? */
export function wantsHebrewFont(tag: string | null | undefined): boolean {
  return !!tag && !!JEWISH_LANGUAGES[tag]?.hebrewFont;
}
