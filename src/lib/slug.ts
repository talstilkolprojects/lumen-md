/**
 * One slug for headings and one key for note names (MASTER_PLAN v3, T26).
 *
 * Headings: exactly what `rehype-slug` puts in the preview's `id`s
 * (github-slugger, Unicode-aware), so an outline entry, a `[[note#heading]]`
 * link and the scroll sync all land on the heading — including Hebrew
 * ones, which the four old ASCII-only copies turned into an empty id.
 *
 * Notes: a name compares by `noteKey` — case-, niqqud-, final-letter- and
 * whitespace-insensitive, `.md` dropped — never by slug, so `[[שלום עולם]]`
 * finds `שלום עולם.md` and no longer matches every other Hebrew note.
 */

import GithubSlugger, { slug as githubSlug } from "github-slugger";
import { normalizeForMatch, stripNiqqud } from "../text/hebrew";

/** The id rehype-slug gives a heading with this text (first occurrence). */
export function headingSlug(text: string): string {
  return githubSlug(text);
}

/**
 * The element id a wiki link's `#fragment` names: a block reference (`^id`,
 * plan 4.8) is the block's own id; anything else is a heading, by its slug.
 */
export function wikiFragmentId(fragment: string): string {
  return fragment.startsWith("^") ? fragment : headingSlug(fragment);
}

/** A slugger that numbers repeats (`a`, `a-1`, …) the way the preview does. */
export function headingSlugger(): { slug: (text: string) => string } {
  const s = new GithubSlugger();
  return { slug: (text: string) => s.slug(text) };
}

/** Comparison key for a note name or wiki-link target. */
export function noteKey(name: string): string {
  return normalizeForMatch(name.replace(/\.(md|markdown)$/i, ""))
    .replace(/[\s_]+/g, " ")
    .trim();
}

/**
 * A page file name for a title in an exported site (plan 9.3): the heading
 * slug — Unicode-aware, so `מדריך התקנה` → `מדריך-התקנה` and not an empty
 * string turned into `page-3` — with niqqud and cantillation removed (a URL
 * and a file name should not depend on vowel marks), runs of dashes folded,
 * at most 80 characters. Empty → `fallback`.
 */
export function pageFileSlug(title: string, fallback: string): string {
  const s = githubSlug(stripNiqqud(title))
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return Array.from(s).slice(0, 80).join("").replace(/-+$/, "") || fallback;
}
