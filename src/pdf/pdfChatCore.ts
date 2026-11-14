/**
 * Plan 6.8 — chat with a PDF on this device: the pure parts (no imports),
 * shared by the reader, the tests and the evaluation script.
 *
 *   pages → chunks (by lines, with the page and line range of each)
 *        → BM25 (+ embeddings, fused with reciprocal rank)
 *        → numbered sources for the answerer
 *        → each citation's quote located on its page and line.
 */

export interface PdfPageText {
  /** 1-based page number. */
  page: number;
  text: string;
  /** The text came from OCR (a scanned page). */
  ocr?: boolean;
}

export interface PdfChunk {
  id: number;
  page: number;
  /** 1-based, inclusive, lines of the page text. */
  lineStart: number;
  lineEnd: number;
  text: string;
}

/** Characters per chunk (about 150 words): small enough to cite, big enough to answer from. */
export const CHUNK_CHARS = 700;

/** A page line, or a piece of a line too long for one chunk; `line` is its 1-based line on the page. */
interface Segment {
  line: number;
  text: string;
}

/** Cut a long line at sentence ends, else at spaces, into pieces of at most `max` characters. */
function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const head = rest.slice(0, max);
    let cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
    cut = cut > max * 0.4 ? cut + 1 : head.lastIndexOf(" ");
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Split each page into chunks of whole lines (a line longer than a chunk is
 * cut at a sentence end or a space). Consecutive chunks of a page share
 * their boundary piece, so a sentence that crosses it is whole in one.
 */
export function chunkPages(pages: readonly PdfPageText[], maxChars = CHUNK_CHARS): PdfChunk[] {
  const out: PdfChunk[] = [];
  for (const p of pages) {
    const segs: Segment[] = [];
    p.text.split("\n").forEach((l, i) => {
      for (const piece of splitLong(l, maxChars)) segs.push({ line: i + 1, text: piece });
    });
    let start = 0;
    while (start < segs.length) {
      let end = start;
      let size = 0;
      while (end < segs.length && (end === start || size + segs[end].text.length + 1 <= maxChars)) {
        size += segs[end].text.length + 1;
        end++;
      }
      const part = segs.slice(start, end);
      const text = joinSegments(part);
      if (text.trim()) out.push({ id: out.length, page: p.page, lineStart: part[0].line, lineEnd: part[part.length - 1].line, text });
      if (end >= segs.length) break;
      // Overlap by one piece, unless that piece alone filled the chunk.
      start = end - 1 > start ? end - 1 : end;
    }
  }
  return out;
}

/** Pieces of one line join with a space, lines with a newline (so the line count stays the page's). */
function joinSegments(part: readonly Segment[]): string {
  let text = "";
  part.forEach((s, i) => {
    if (i) text += s.line === part[i - 1].line ? " " : "\n".repeat(s.line - part[i - 1].line);
    text += s.text;
  });
  return text;
}

/* ─── BM25 ────────────────────────────────────────────────────────────── */

const NIQQUD = /[\u0591-\u05C7]/g;
/** Hebrew one-letter prefixes (ו, ה, ב, ל, מ, ש, כ) peeled for matching: "והבית" ~ "בית". */
const HE_PREFIX = /^[\u05D5\u05D4\u05D1\u05DC\u05DE\u05E9\u05DB]{1,2}(?=[\u05D0-\u05EA]{3,})/;

const STOP = new Set([
  "the", "a", "an", "of", "to", "in", "and", "or", "is", "are", "was", "were", "be", "it", "that", "this", "for", "on", "with", "as", "by", "at", "from", "what", "which", "who", "whom", "how", "did", "does", "do",
  "של", "את", "על", "עם", "זה", "זו", "הוא", "היא", "הם", "מה", "מי", "איך", "כי", "גם", "או", "אם", "לא",
]);

/** A light English stem: plural -s, -ing, -ed (only when a 4-letter stem is left). */
function stem(w: string): string {
  if (w.length > 6 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** Lower-case word tokens, niqqud removed, Hebrew prefixes peeled, stop words out. */
export function tokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.normalize("NFKC").replace(NIQQUD, "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!raw || STOP.has(raw)) continue;
    const w = raw.replace(HE_PREFIX, "");
    if (w.length < 2 && !/\p{N}/u.test(w)) continue;
    out.push(/^[a-z]+$/.test(w) ? stem(w) : w);
  }
  return out;
}

export interface Bm25Index {
  docs: string[][];
  df: Map<string, number>;
  avgLen: number;
}

export function bm25Index(texts: readonly string[]): Bm25Index {
  const docs = texts.map(tokens);
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const avgLen = docs.reduce((a, d) => a + d.length, 0) / Math.max(1, docs.length);
  return { docs, df, avgLen };
}

/** Indexes of the best documents for `query`, best first, with their scores (k1 1.2, b 0.75). */
export function bm25Search(index: Bm25Index, query: string, k = 8): Array<{ i: number; score: number }> {
  const q = [...new Set(tokens(query))];
  const n = index.docs.length;
  const scores: Array<{ i: number; score: number }> = [];
  index.docs.forEach((d, i) => {
    let s = 0;
    const tf = new Map<string, number>();
    for (const w of d) tf.set(w, (tf.get(w) ?? 0) + 1);
    for (const w of q) {
      const f = tf.get(w);
      if (!f) continue;
      const df = index.df.get(w) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      s += (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * d.length) / Math.max(1, index.avgLen)));
    }
    if (s > 0) scores.push({ i, score: s });
  });
  return scores.sort((a, b) => b.score - a.score || a.i - b.i).slice(0, k);
}

/** Reciprocal-rank fusion of ranked index lists (k = 60). */
export function fuse(lists: ReadonlyArray<readonly number[]>, k = 60, limit = 6): number[] {
  const score = new Map<number, number>();
  for (const list of lists) list.forEach((i, rank) => score.set(i, (score.get(i) ?? 0) + 1 / (k + rank + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, limit).map(([i]) => i);
}

/** Cosine similarity of two vectors of the same length. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/* ─── the answerer's sources and its citations ────────────────────────── */

/** The numbered sources the answerer reads: `[n] (page P, lines a–b)` + the chunk text. */
export function sourcesBlock(chunks: readonly PdfChunk[]): string {
  return chunks.map((c, i) => `[${i + 1}] (page ${c.page}, lines ${c.lineStart}–${c.lineEnd})\n${c.text}`).join("\n\n");
}

export interface PdfAnswerOut {
  answer: string;
  citations: Array<{ source: number; quote: string }>;
}

export interface LocatedCitation {
  /** The source number the model cited. */
  source: number;
  quote: string;
  page: number;
  /** 1-based line of the page where the quote starts. */
  line: number;
}

const squash = (s: string) => s.normalize("NFKC").replace(NIQQUD, "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Where a quote is on its chunk's page: the page and the 1-based line
 * where it starts. Null when the quote isn't in the chunk (whitespace and
 * line breaks don't count).
 */
export function locateQuote(quote: string, chunk: PdfChunk): { page: number; line: number } | null {
  const q = squash(quote);
  if (!q) return null;
  const lines = chunk.text.split("\n");
  // Every line start as an offset into the squashed chunk text.
  let flat = "";
  const starts: number[] = [];
  for (const l of lines) {
    starts.push(flat.length + (flat ? 1 : 0));
    flat = flat ? `${flat} ${squash(l)}` : squash(l);
  }
  const at = flat.indexOf(q);
  if (at < 0) return null;
  let li = 0;
  while (li + 1 < starts.length && starts[li + 1] <= at) li++;
  return { page: chunk.page, line: chunk.lineStart + li };
}
