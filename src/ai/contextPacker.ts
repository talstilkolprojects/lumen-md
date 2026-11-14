/**
 * Context packer (Plan D: D3): send the model the parts of the documents
 * that matter for a question, inside a token budget, instead of whole
 * files (or their first N characters).
 *
 * Each document is split along headings (chunkMarkdown); chunks are scored
 * with BM25 against the question; the best chunks across all documents are
 * kept in their original order until the budget is used, each document
 * prefixed with its heading outline so the model still sees its shape.
 * Short inputs that already fit are passed through unchanged.
 */
import { chunkMarkdown } from "./semanticSearch";
import { estimateTokens } from "./usage";
import type { AiMode } from "./aiMode";

export type { AiMode };
export { getAiMode, setAiMode } from "./aiMode";

/** Tokens of the separators around one kept section ("\n\n[…]\n\n"). */
const SEPARATOR_TOKENS = 3;

/** Context budget (tokens) per AI mode. */
export const CONTEXT_BUDGET: Record<AiMode, number> = { economy: 2_000, balanced: 5_000, quality: 12_000 };

export interface PackInput {
  path: string;
  content: string;
}

export interface PackedDoc {
  path: string;
  /** The excerpt to send (whole text when it fit). */
  text: string;
  /** True when parts were left out. */
  trimmed: boolean;
}

const STOP = new Set(
  "a an and are as at be but by for from has have how i in is it its of on or that the this to was what when where which who why will with you your".split(" "),
);
/** Tiny English-leaning stemmer: roses → rose, pruning / prune → prun. */
function stem(w: string): string {
  if (w.length <= 4) return w;
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.endsWith("e") && w.length > 4) w = w.slice(0, -1);
  return w;
}
const terms = (s: string) =>
  (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);

/** Heading outline of a document ("# A › ## B"), capped. */
function outline(text: string, max = 600): string {
  const hs = [...text.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)].map((m) => `${m[1]} ${m[2]}`);
  const out = hs.join(" · ");
  return out.length > max ? out.slice(0, max) + " …" : out;
}

/**
 * Pack documents for `query` into about `budgetTokens`. Documents keep
 * their order; inside each, kept chunks keep theirs, with "[…]" where text
 * was left out.
 */
export function packContext(query: string, docs: readonly PackInput[], budgetTokens: number): PackedDoc[] {
  const total = docs.reduce((n, d) => n + estimateTokens(d.content), 0);
  if (total <= budgetTokens) return docs.map((d) => ({ path: d.path, text: d.content, trimmed: false }));

  type Chunk = { doc: number; idx: number; text: string; tokens: number; score: number; tf: Map<string, number>; len: number; partial?: boolean };
  const chunks: Chunk[] = [];
  docs.forEach((d, doc) => {
    chunkMarkdown(d.content).forEach((c, idx) => {
      const words = terms(c.text);
      const tf = new Map<string, number>();
      for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
      // + the "\n\n[…]\n\n" around it in the packed text.
      chunks.push({ doc, idx, text: c.text.trim(), tokens: estimateTokens(c.text) + SEPARATOR_TOKENS, score: 0, tf, len: words.length });
    });
  });
  // BM25 over chunks.
  const q = [...new Set(terms(query))];
  const N = chunks.length || 1;
  const avg = chunks.reduce((n, c) => n + c.len, 0) / N || 1;
  const df = new Map<string, number>();
  for (const t of q) df.set(t, chunks.filter((c) => c.tf.has(t)).length);
  const k1 = 1.2;
  const b = 0.75;
  for (const c of chunks) {
    let s = 0;
    for (const t of q) {
      const f = c.tf.get(t) ?? 0;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * c.len) / avg)));
    }
    // A document's opening chunk gets a small boost: it usually says what
    // the document is about.
    c.score = s + (c.idx === 0 ? 0.25 : 0);
  }

  // Outlines first (cheap, always useful), then chunks by score.
  const outlines = docs.map((d) => outline(d.content));
  let used = outlines.reduce((n, o) => n + estimateTokens(o) + 8, 0);
  const keep = new Set<Chunk>();
  /** The beginning of `c` (cut at a paragraph / sentence) in about `room` tokens. */
  const cutTo = (c: Chunk, room: number) => {
    const chars = room * 4 - 4;
    let cut = c.text.lastIndexOf("\n\n", chars);
    if (cut < chars / 2) cut = c.text.lastIndexOf(". ", chars) + 1;
    if (cut < chars / 2) cut = chars;
    c.text = c.text.slice(0, cut).trimEnd() + " …";
    c.tokens = estimateTokens(c.text) + SEPARATOR_TOKENS;
    c.partial = true;
  };
  // A document the retriever chose but that shares no words with the
  // question (a semantic match) still gets its opening, within half a fair
  // share; documents with matching sections compete below.
  const share = Math.floor((budgetTokens - used) / Math.max(1, docs.length) / 2);
  docs.forEach((_, doc) => {
    const mine = chunks.filter((c) => c.doc === doc);
    if (!mine.length || mine.some((c) => c.score > 0.25)) return;
    const first = mine[0];
    const room = Math.min(share, budgetTokens - used);
    if (first.tokens > room) {
      if (room < 40) return;
      cutTo(first, room);
    }
    keep.add(first);
    used += first.tokens;
  });
  let relevantKept = false;
  for (const c of [...chunks].sort((x, y) => y.score - x.score)) {
    if (keep.has(c)) continue;
    if (c.score <= 0 && keep.size > 0) break; // nothing relevant left
    const left = budgetTokens - used;
    if (c.tokens > left) {
      // The most relevant chunk doesn't fit whole: keep its beginning
      // (cut at a paragraph or sentence) rather than skipping it.
      if (!relevantKept && c.score > 0 && left > 40) {
        cutTo(c, left);
        keep.add(c);
        used += c.tokens;
        relevantKept = true;
      }
      continue; // otherwise try smaller ones
    }
    keep.add(c);
    used += c.tokens;
    if (c.score > 0) relevantKept = true;
  }

  const assemble = (): PackedDoc[] =>
    docs.map((d, doc) => {
      const mine = chunks.filter((c) => c.doc === doc);
      const kept = mine.filter((c) => keep.has(c));
      if (kept.length === mine.length && !kept.some((c) => c.partial)) return { path: d.path, text: d.content, trimmed: false };
      const parts: string[] = [];
      if (outlines[doc]) parts.push(`Outline: ${outlines[doc]}`);
      let prev = -1;
      for (const c of kept) {
        if (c.idx !== prev + 1) parts.push("[…]");
        parts.push(c.text);
        prev = c.idx;
      }
      if (prev !== mine.length - 1) parts.push("[…]");
      return { path: d.path, text: parts.join("\n\n"), trimmed: true };
    });
  // The separators and gap markers cost tokens too: drop the least relevant
  // kept sections until the assembled text fits.
  let out = assemble();
  const size = (o: PackedDoc[]) => o.reduce((n, p) => n + estimateTokens(p.text), 0);
  while (size(out) > budgetTokens && keep.size > 0) {
    const worst = [...keep].reduce((a, c) => (c.score < a.score ? c : a));
    keep.delete(worst);
    out = assemble();
  }
  return out;
}
