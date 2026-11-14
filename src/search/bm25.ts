/**
 * BM25 over the workspace (plan 5.2).
 *
 * An inverted index that is updated one document at a time — `set` adds
 * or replaces a document, `remove` takes it out — so a saved note costs
 * one re-tokenisation, never a rebuild. Scores are Okapi BM25 (k1 = 1.2,
 * b = 0.75) with the note's name as a boosted field (its terms count
 * `NAME_BOOST` times, BM25F-style, inside the same length-normalised tf),
 * and weighted query terms (`text/searchTokens`: exact forms 1, Hebrew
 * prefix-less stems less).
 *
 * Loaded lazily by `storage/workspaceIndex` the first time a search runs;
 * nothing here is in the startup bundle.
 */

import { documentTerms, queryTerms, STEM, type QueryTerm } from "../text/searchTokens";

export const K1 = 1.2;
export const B = 0.75;
/** A term in the note's name counts this many times. */
export const NAME_BOOST = 3;
/** A term the last query word is the start of (typing ahead: "gard" → "garden") counts this much. */
export const PREFIX_WEIGHT = 0.5;
/** At most this many completions of the last word, the most frequent first. */
const MAX_PREFIX_TERMS = 30;

interface Doc {
  id: string;
  /** Internal number: postings are keyed by it (small integers are V8's fastest Map keys). */
  num: number;
  /** What the document was indexed from (identity: an unchanged note is not re-indexed). */
  source: string;
  name: string;
  /** Weighted length (name terms count NAME_BOOST times). */
  length: number;
  /** Its distinct terms (for removal). */
  terms: string[];
}

export interface Bm25Hit {
  id: string;
  score: number;
  /** The query terms found in the document (exact or stem), best first. */
  matched: string[];
  /** Every word of the query matched (only then can the query occur in it as a phrase). */
  complete: boolean;
}

export class Bm25Index {
  private docs = new Map<string, Doc>();
  private byNum = new Map<number, Doc>();
  private postings = new Map<string, Map<number, number>>();
  private totalLength = 0;
  private nextNum = 0;

  get size(): number {
    return this.docs.size;
  }

  has(id: string): boolean {
    return this.docs.has(id);
  }

  /** True when `id` is indexed from exactly this text and name. */
  isCurrent(id: string, text: string, name = ""): boolean {
    const d = this.docs.get(id);
    return !!d && d.source === text && d.name === name;
  }

  /** Add or replace one document. */
  set(id: string, text: string, name = ""): void {
    if (this.isCurrent(id, text, name)) return;
    this.remove(id);
    const counts = new Map<string, number>();
    let length = 0;
    for (const t of documentTerms(text)) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
      length++;
    }
    for (const t of documentTerms(name)) {
      counts.set(t, (counts.get(t) ?? 0) + NAME_BOOST);
      length += NAME_BOOST;
    }
    const num = this.nextNum++;
    const doc: Doc = { id, num, source: text, name, length, terms: [...counts.keys()] };
    this.docs.set(id, doc);
    this.byNum.set(num, doc);
    this.totalLength += length;
    for (const [t, tf] of counts) {
      let p = this.postings.get(t);
      if (!p) this.postings.set(t, (p = new Map()));
      p.set(num, tf);
    }
  }

  remove(id: string): void {
    const d = this.docs.get(id);
    if (!d) return;
    this.docs.delete(id);
    this.byNum.delete(d.num);
    this.totalLength -= d.length;
    for (const t of d.terms) {
      const p = this.postings.get(t);
      if (!p) continue;
      p.delete(d.num);
      if (!p.size) this.postings.delete(t);
    }
  }

  /** Ids currently indexed. */
  ids(): IterableIterator<string> {
    return this.docs.keys();
  }

  /** Inverse document frequency (BM25+'s non-negative form). */
  idf(term: string): number {
    const df = this.postings.get(term)?.size ?? 0;
    const n = this.docs.size;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** The best `limit` documents for `query` (or for pre-built weighted terms). */
  /**
   * Terms the last query word is the start of, as weaker forms of that word
   * (search as you type: the word may not be finished).
   */
  private completions(terms: QueryTerm[]): QueryTerm[] {
    const last = Math.max(...terms.map((t) => t.group));
    const base = terms.find((t) => t.group === last && t.weight === 1)?.term;
    if (!base || base.length < 2 || base.startsWith(STEM)) return [];
    const found: Array<[string, number]> = [];
    for (const [term, p] of this.postings) if (term.length > base.length && term.startsWith(base)) found.push([term, p.size]);
    found.sort((a, b) => b[1] - a[1]);
    return found.slice(0, MAX_PREFIX_TERMS).map(([term]) => ({ term, weight: PREFIX_WEIGHT, group: last }));
  }

  search(query: string | QueryTerm[], opts: { limit?: number; filter?: (id: string) => boolean; prefix?: boolean } = {}): Bm25Hit[] {
    const base = typeof query === "string" ? queryTerms(query) : query;
    const n = this.docs.size;
    if (!n || !base.length) return [];
    const terms = opts.prefix ? [...base, ...this.completions(base)] : base;
    const groups = new Set(base.map((t) => t.group)).size;
    const avg = this.totalLength / n || 1;
    // Per document, per query word: the best of its forms (see QueryTerm.group).
    const scores = new Map<Doc, { best: Map<number, [string, number]> }>();
    const allowed = new Map<Doc, boolean>();
    for (const { term, weight, group } of terms) {
      const p = this.postings.get(term);
      if (!p) continue;
      const idf = this.idf(term) * weight;
      for (const [num, tf] of p) {
        const doc = this.byNum.get(num)!;
        if (opts.filter) {
          let ok = allowed.get(doc);
          if (ok === undefined) allowed.set(doc, (ok = opts.filter(doc.id)));
          if (!ok) continue;
        }
        const len = doc.length;
        const s = (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * len) / avg));
        let e = scores.get(doc);
        if (!e) scores.set(doc, (e = { best: new Map() }));
        const prev = e.best.get(group);
        if (!prev || s > prev[1]) e.best.set(group, [term, s]);
      }
    }
    const limit = opts.limit ?? 30;
    const hits: Bm25Hit[] = [];
    for (const [doc, e] of scores) {
      const parts = [...e.best.values()].sort((a, b) => b[1] - a[1]);
      hits.push({ id: doc.id, score: parts.reduce((sum, [, v]) => sum + v, 0), matched: parts.map(([t]) => t), complete: e.best.size === groups });
    }
    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return hits.slice(0, limit);
  }
}
