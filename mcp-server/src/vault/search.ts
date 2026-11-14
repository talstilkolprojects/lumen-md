/**
 * In-memory search index over the vault on disk (plan W2.3).
 *
 * The MCP server and the CLI keep one index per process: built on the
 * first search, then brought up to date before each search by comparing
 * file sizes and modification times (only changed notes are read again).
 * Scoring is BM25 over Unicode words; Hebrew words are also indexed
 * without niqqud and without one leading prefix letter (ו ה ב ל מ ש כ), so
 * "בפרויקט" finds "פרויקט". Every query word must match (AND).
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { isNoteName } from "./paths.js";

export interface SearchHit {
  path: string;
  title: string;
  score: number;
  /** The first line that contains a query word (≤ 200 chars). */
  snippet: string;
}

interface Doc {
  path: string;
  size: number;
  mtimeMs: number;
  text: string;
  title: string;
  length: number;
  terms: Map<string, number>;
}

const NIQQUD = /[֑-ׇ]/g;
const HEB_PREFIX = /^[ובהלמשכ]/;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}_'’-]*/gu;

/** The index terms of one word: itself, plus (Hebrew) without niqqud and without a prefix letter. */
export function wordTerms(word: string): string[] {
  const w = word.toLowerCase().replace(NIQQUD, "").replace(/['’-]+$/, "");
  if (!w) return [];
  const out = [w];
  if (/[א-ת]/.test(w) && w.length > 3 && HEB_PREFIX.test(w)) out.push(w.slice(1));
  return out;
}

export function tokenize(text: string): string[] {
  return text.match(WORD) ?? [];
}

function titleOf(rel: string, text: string): string {
  const m = /^#\s+(.+)$/m.exec(text.slice(0, 2000));
  return m ? m[1].trim() : path.posix.basename(rel).replace(/\.(md|markdown|txt)$/i, "");
}

async function walk(dir: string, prefix: string, out: { rel: string; abs: string }[]): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const sub: Promise<void>[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) sub.push(walk(abs, rel, out));
    else if (e.isFile() && isNoteName(e.name)) out.push({ rel, abs });
  }
  await Promise.all(sub);
}

/** Run `fn` over `items` with at most `n` at a time. */
async function pool<T>(items: readonly T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

export class VaultIndex {
  private docs = new Map<string, Doc>();
  private postings = new Map<string, Map<string, number>>();
  private totalLength = 0;
  private lastRefresh = 0;
  private refreshing: Promise<void> | null = null;

  constructor(
    readonly vault: string,
    private readonly opts: { minRefreshMs?: number } = {},
  ) {}

  get size(): number {
    return this.docs.size;
  }

  private remove(rel: string): void {
    const d = this.docs.get(rel);
    if (!d) return;
    for (const term of d.terms.keys()) {
      const p = this.postings.get(term);
      p?.delete(rel);
      if (p && p.size === 0) this.postings.delete(term);
    }
    this.totalLength -= d.length;
    this.docs.delete(rel);
  }

  private add(rel: string, text: string, size: number, mtimeMs: number): void {
    const terms = new Map<string, number>();
    let length = 0;
    for (const word of tokenize(text)) {
      length++;
      for (const t of wordTerms(word)) terms.set(t, (terms.get(t) ?? 0) + 1);
    }
    const title = titleOf(rel, text);
    // Title words count extra.
    for (const word of tokenize(title)) for (const t of wordTerms(word)) terms.set(t, (terms.get(t) ?? 0) + 2);
    const doc: Doc = { path: rel, size, mtimeMs, text, title, length, terms };
    for (const [t, n] of terms) {
      let p = this.postings.get(t);
      if (!p) this.postings.set(t, (p = new Map()));
      p.set(rel, n);
    }
    this.totalLength += length;
    this.docs.set(rel, doc);
  }

  /** Bring the index up to date with the disk (throttled by `minRefreshMs`, default 0). */
  async refresh(force = false): Promise<void> {
    if (this.refreshing) return this.refreshing;
    if (!force && Date.now() - this.lastRefresh < (this.opts.minRefreshMs ?? 0)) return;
    this.refreshing = (async () => {
      const files: { rel: string; abs: string }[] = [];
      await walk(this.vault, "", files);
      const seen = new Set<string>();
      await pool(files, 64, async ({ rel, abs }) => {
        seen.add(rel);
        let st: import("node:fs").Stats;
        try {
          st = await fs.stat(abs);
        } catch {
          return;
        }
        const d = this.docs.get(rel);
        if (d && d.size === st.size && d.mtimeMs === st.mtimeMs) return;
        let text: string;
        try {
          text = await fs.readFile(abs, "utf8");
        } catch {
          return;
        }
        this.remove(rel);
        this.add(rel, text, st.size, st.mtimeMs);
      });
      for (const rel of [...this.docs.keys()]) if (!seen.has(rel)) this.remove(rel);
      this.lastRefresh = Date.now();
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** Every note path, sorted. */
  paths(): string[] {
    return [...this.docs.keys()].sort();
  }

  text(rel: string): string | undefined {
    return this.docs.get(rel)?.text;
  }

  async search(query: string, limit = 20): Promise<SearchHit[]> {
    await this.refresh();
    return this.searchLoaded(query, limit);
  }

  /** Search what is loaded, without touching the disk. */
  searchLoaded(query: string, limit = 20): SearchHit[] {
    const words = tokenize(query);
    if (!words.length || !this.docs.size) return [];
    const N = this.docs.size;
    const avg = this.totalLength / N || 1;
    const k1 = 1.2;
    const b = 0.75;
    let scores: Map<string, number> | null = null;
    for (const word of words) {
      // A word matches through any of its terms (with and without a prefix letter).
      const per = new Map<string, number>();
      for (const term of wordTerms(word)) {
        const p = this.postings.get(term);
        if (!p) continue;
        const idf = Math.log(1 + (N - p.size + 0.5) / (p.size + 0.5));
        for (const [rel, tf] of p) {
          const d = this.docs.get(rel)!;
          const s = (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / avg));
          per.set(rel, Math.max(per.get(rel) ?? 0, s));
        }
      }
      if (scores === null) scores = per;
      else {
        const next = new Map<string, number>();
        for (const [rel, s] of scores) {
          const add = per.get(rel);
          if (add !== undefined) next.set(rel, s + add);
        }
        scores = next;
      }
      if (!scores.size) return [];
    }
    const ranked = [...(scores ?? new Map<string, number>())].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, Math.max(1, limit));
    const needles = words.flatMap(wordTerms);
    return ranked.map(([rel, score]) => {
      const d = this.docs.get(rel)!;
      return { path: rel, title: d.title, score: Math.round(score * 1000) / 1000, snippet: snippetOf(d.text, needles) };
    });
  }
}

function snippetOf(text: string, needles: string[]): string {
  const lines = text.split("\n");
  for (const line of lines) {
    const low = line.toLowerCase().replace(NIQQUD, "");
    if (needles.some((n) => low.includes(n))) return line.trim().slice(0, 200);
  }
  return (lines.find((l) => l.trim()) ?? "").trim().slice(0, 200);
}
