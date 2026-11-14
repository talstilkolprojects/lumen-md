/**
 * Related notes while writing (plan W2.2): the notes closest to the
 * paragraph at the cursor, and the notes it mentions without linking.
 *
 * Ranking is BM25 over the workspace index (plan 5.2, with the Hebrew
 * morphology of W2.11): the paragraph's most informative words — the 16
 * with the highest IDF — are the query, so a long paragraph costs the same
 * as a short one. When an on-device embedding index exists (Ollama or
 * transformers.js; never a cloud provider, so typing sends nothing), its
 * hits are fused in by reciprocal rank (`fuseRanks`).
 *
 * Pure functions over an index: the panel (ui/RelatedPanel.tsx) and the
 * editor plugin (linkHints.ts) call them after typing pauses.
 */
import { queryTerms, type QueryTerm } from "../text/searchTokens";
import type { Bm25Index } from "../search/bm25";

export interface RelatedHit {
  path: string;
  score: number;
  /** Query words that matched, best first. */
  matched: string[];
}

export interface Paragraph {
  from: number;
  to: number;
  text: string;
}

/** The paragraph (text between blank lines) around `pos`; front matter and fences count as their own block. */
export function paragraphAt(doc: string, pos: number): Paragraph {
  const p = Math.max(0, Math.min(doc.length, pos));
  let from = doc.lastIndexOf("\n\n", p > 0 ? p - 1 : 0);
  from = from < 0 ? 0 : from + 2;
  if (from > p) from = p;
  let to = doc.indexOf("\n\n", p);
  if (to < 0) to = doc.length;
  return { from, to, text: doc.slice(from, to) };
}

/** Up to `max` query words of `text`, the rarest in the index first (each with its forms). */
export function salientTerms(index: Pick<Bm25Index, "idf">, text: string, max = 16): QueryTerm[] {
  const terms = queryTerms(text);
  // A word no note has (df 0) gets the highest IDF but cannot find anything: leave it out.
  const unseen = index.idf("\u0000");
  const best = new Map<number, number>();
  const firstTerm = new Map<number, string>();
  for (const t of terms) {
    const raw = index.idf(t.term);
    if (raw >= unseen) continue;
    const idf = raw * t.weight;
    if (idf > (best.get(t.group) ?? -1)) best.set(t.group, idf);
    if (!firstTerm.has(t.group)) firstTerm.set(t.group, t.term);
  }
  // The same word twice in a paragraph is one query word.
  const seen = new Set<string>();
  const groups = [...best]
    .filter(([g, idf]) => idf > 0 && !seen.has(firstTerm.get(g)!) && seen.add(firstTerm.get(g)!))
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([g]) => g);
  const keep = new Set(groups);
  return terms.filter((t) => keep.has(t.group));
}

/** Reciprocal-rank fusion of several rankings (k = 60), best first. */
export function fuseRanks(lists: ReadonlyArray<ReadonlyArray<{ path: string }>>, weights: readonly number[] = []): Map<string, number> {
  const out = new Map<string, number>();
  lists.forEach((list, li) => list.forEach((h, i) => out.set(h.path, (out.get(h.path) ?? 0) + (weights[li] ?? 1) / (60 + i + 1))));
  return out;
}

export interface RelatedOptions {
  limit?: number;
  /** The note being written: never related to itself. */
  self?: string | null;
  /** Hits from an on-device embedding index for the same paragraph. */
  semantic?: ReadonlyArray<{ path: string; score: number }>;
  /** Only these paths (notes / folders the user has not turned off). */
  filter?: (path: string) => boolean;
}

/** The notes most related to `paragraph`. */
export function relatedNotes(index: Pick<Bm25Index, "idf" | "search">, paragraph: string, opts: RelatedOptions = {}): RelatedHit[] {
  const limit = opts.limit ?? 5;
  const terms = salientTerms(index, paragraph);
  if (!terms.length && !opts.semantic?.length) return [];
  const ok = (p: string) => p !== opts.self && (!opts.filter || opts.filter(p));
  const bm = terms.length ? index.search(terms, { limit: limit * 4, filter: ok }) : [];
  // Weak matches (one common word) are noise in a side panel.
  const top = bm[0]?.score ?? 0;
  const lexical = bm.filter((h) => h.score >= top * 0.2 && (h.matched.length >= 2 || terms.length <= 2));
  const sem = (opts.semantic ?? []).filter((h) => ok(h.path));
  if (!sem.length) return lexical.slice(0, limit).map((h) => ({ path: h.id, score: h.score, matched: h.matched }));
  const fused = fuseRanks([lexical.map((h) => ({ path: h.id })), sem], [1, 1.2]);
  const matched = new Map(lexical.map((h) => [h.id, h.matched]));
  return [...fused]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([path, score]) => ({ path, score, matched: matched.get(path) ?? [] }));
}

/* ── Suggested links ─────────────────────────────────────────────────── */

export interface LinkHint {
  /** Offsets in the document. */
  from: number;
  to: number;
  /** The note's path and the name to link to (`[[name]]`). */
  path: string;
  name: string;
}

const HEB = /[א-ת]/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Ranges in a paragraph where a link must not be suggested: code, links, URLs, headings. */
function guarded(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const re of [/`[^`\n]*`/g, /\[\[[^\]]*\]\]/g, /\[[^\]]*\]\([^)]*\)/g, /https?:\/\/\S+/g, /^#{1,6} .*$/gm, /^```[\s\S]*?(^```|$(?![\s\S]))/gm]) {
    for (const m of text.matchAll(re)) out.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  return out;
}

export interface TitleEntry {
  path: string;
  /** File name without the extension: what `[[…]]` links to. */
  name: string;
  /** Title words (lower case), for the first-word lookup. */
  first: string;
}

/** Note names worth suggesting: at least 4 letters, not ambiguous (two notes, one name). */
export function titleEntries(paths: readonly string[]): TitleEntry[] {
  const byName = new Map<string, string[]>();
  for (const p of paths) {
    const name = (p.split("/").pop() ?? p).replace(/\.(md|markdown)$/i, "");
    if (name.replace(/[^\p{L}\p{N}]/gu, "").length < 4) continue;
    const key = name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), p]);
  }
  const out: TitleEntry[] = [];
  for (const [key, list] of byName) {
    if (list.length !== 1) continue;
    const name = (list[0].split("/").pop() ?? list[0]).replace(/\.(md|markdown)$/i, "");
    out.push({ path: list[0], name, first: key.split(/\s+/)[0] });
  }
  return out;
}

/**
 * Note names mentioned in `paragraph` (at document offset `base`) and not
 * linked there: one hint per note, the first mention, the longest name
 * first where two overlap. A Hebrew name also matches after one prefix
 * letter (the letter stays outside the link). The word being typed — one
 * touching `cursor` — is left alone until the user moves on.
 */
export function linkHints(paragraph: string, base: number, titles: readonly TitleEntry[], opts: { self?: string | null; cursor?: number; linked?: ReadonlySet<string> } = {}): LinkHint[] {
  const lower = paragraph.toLowerCase();
  const skip = guarded(paragraph);
  const out: LinkHint[] = [];
  const taken: [number, number][] = [];
  const sorted = [...titles].sort((a, b) => b.name.length - a.name.length);
  for (const t of sorted) {
    if (t.path === opts.self || opts.linked?.has(t.name.toLowerCase())) continue;
    if (!lower.includes(t.first.replace(/^[ובהלמשכ](?=[א-ת]{3})/, ""))) continue;
    const words = t.name.split(/\s+/).map(escapeRe).join("\\s+");
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])(${HEB.test(t.name) ? "[ובהלמשכ]?" : ""})(${words})(?![\\p{L}\\p{N}_])`, "iu");
    const m = re.exec(paragraph);
    if (!m) continue;
    const from = (m.index ?? 0) + m[1].length;
    const to = from + m[2].length;
    if (skip.some(([a, b]) => from < b && to > a) || taken.some(([a, b]) => from < b && to > a)) continue;
    if (opts.cursor !== undefined && base + to >= opts.cursor && base + from <= opts.cursor) continue;
    taken.push([from, to]);
    out.push({ from: base + from, to: base + to, path: t.path, name: t.name });
  }
  return out.sort((a, b) => a.from - b.from);
}

/** The text a hint becomes: `[[name]]`, or `[[name|as written]]`. */
export function linkText(hint: LinkHint, written: string): string {
  return written === hint.name ? `[[${hint.name}]]` : `[[${hint.name}|${written}]]`;
}
