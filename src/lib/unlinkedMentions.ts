/**
 * Unlinked mentions (plan 4.6): where a note names another note's title in
 * plain text, without a `[[link]]`. Shown in the backlinks panel with a
 * "Link" button that turns the mention into a link.
 *
 * Rules (they are the `unlinked` golden set's, plan 7.10):
 *  - whole words only — `Q3 Goalss` and `פגישת צוותים` are not mentions;
 *  - Latin titles match case-insensitively, the text keeps its own case;
 *  - a Hebrew title may carry a prefix: ו ה ב ל מ ש כ, וב, של
 *    (`מתל אביב`); the span is the title, the prefix is reported apart;
 *  - longest title first, and one title's span is never another's;
 *  - not inside a [[link]] or embed, a Markdown link (text or URL), a URL,
 *    code (spans and blocks), front matter or HTML tags;
 *  - never the note's own title.
 */

import { stripCode } from "../lint/vaultDoctor";

export interface Mention {
  /** UTF-16 offsets of the title in the text (the prefix excluded). */
  start: number;
  end: number;
  /** The title as written in the text. */
  text: string;
  /** The note it names. */
  target: string;
  /** A Hebrew prefix letter (or two) before it. */
  prefix?: string;
}

const PREFIXES = ["וב", "של", "ו", "ה", "ב", "ל", "מ", "ש", "כ"];
const HEBREW = /[֐-׿]/;
const WORD = /[\p{L}\p{M}\p{N}_]/u;

/** Ranges of the text where a title is not a mention. */
function excluded(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const add = (re: RegExp) => {
    for (const m of text.matchAll(re)) out.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  };
  add(/^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/g); // front matter
  // Code as the renderer sees it — fences (also in quotes and lists),
  // indented code, code spans, HTML comments: Vault Doctor's stripCode
  // blanks it to spaces, so every changed character is code.
  const scan = stripCode(text);
  for (let i = 0; i < text.length; i++) {
    if (scan[i] === text[i]) continue;
    let j = i;
    while (j < text.length && scan[j] !== text[j]) j++;
    out.push([i, j]);
    i = j;
  }
  add(/!?\[\[[^\]\n]*\]\]/g); // wiki links, embeds
  add(/!?\[[^\]\n]*\]\([^)\n]*\)/g); // Markdown links and images
  add(/\[[^\]\n]*\]\[[^\]\n]*\]/g); // reference links
  add(/<[A-Za-z][^>\n]*>/g); // HTML tags (their attributes)
  add(/\b(?:https?|ftp|mailto):[^\s<>()]+|\bwww\.[^\s<>()]+/g); // URLs
  return out.sort((a, b) => a[0] - b[0]);
}

const fold = (s: string) => s.toLowerCase();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every unlinked mention of `titles` in `text`, in text order. `ownTitle` (the note's own) never counts. */
export function findUnlinkedMentions(text: string, titles: readonly string[], ownTitle?: string): Mention[] {
  const blocked = excluded(text);
  const taken: Array<[number, number]> = [];
  const overlaps = (a: number, b: number, list: Array<[number, number]>) => list.some(([x, y]) => a < y && b > x);
  const own = ownTitle === undefined ? null : fold(ownTitle.trim());
  const sorted = [...new Set(titles.map((t) => t.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  const out: Mention[] = [];
  for (const title of sorted) {
    const isOwn = own !== null && fold(title) === own;
    // A case-insensitive search on the text itself: offsets stay the text's
    // (lowercasing the whole text can change its length: `İ`).
    const re = new RegExp(escapeRe(title), "giu");
    for (let hit = re.exec(text); hit; hit = re.exec(text)) {
      const at = hit.index;
      re.lastIndex = at + 1;
      const end = at + hit[0].length;
      if (end < text.length && WORD.test(text[end])) continue;
      let prefix = "";
      if (at > 0 && WORD.test(text[at - 1])) {
        if (!HEBREW.test(title[0])) continue;
        prefix = PREFIXES.find((p) => text.slice(at - p.length, at) === p && (at - p.length === 0 || !WORD.test(text[at - p.length - 1]))) ?? "";
        if (!prefix) continue;
      }
      const from = at - prefix.length;
      // Its own title, a span another (longer) title has, or excluded text: not a mention, and nothing shorter inside it is either.
      if (overlaps(from, end, blocked) || overlaps(from, end, taken)) continue;
      taken.push([from, end]);
      if (isOwn) continue;
      out.push({ start: at, end, text: text.slice(at, end), target: title, ...(prefix ? { prefix } : {}) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The text with one mention turned into a link: `[[Title]]`, or `[[Title|as written]]` when it reads differently. The prefix stays outside. */
export function linkMention(text: string, m: Pick<Mention, "start" | "end" | "target">, linkTarget: string = m.target): string {
  const written = text.slice(m.start, m.end);
  const link = written === linkTarget ? `[[${linkTarget}]]` : `[[${linkTarget}|${written}]]`;
  return text.slice(0, m.start) + link + text.slice(m.end);
}
