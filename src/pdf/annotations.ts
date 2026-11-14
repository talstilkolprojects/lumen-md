/**
 * PDF highlights as W3C Web Annotations (plan 4.14).
 *
 * A highlight targets a page of the PDF (a FragmentSelector in the RFC 3778
 * `page=N` form, with the highlight's box as `viewrect`) refined by a
 * TextQuoteSelector — the exact text plus a little of what comes before and
 * after it. The quote, not the character offset, is what finds the highlight
 * again: when the text layer of a page changes slightly (another pdf.js
 * version, a re-saved file, OCR text instead of a text layer) the quote is
 * re-anchored by exact match, then by whitespace / mark-insensitive match,
 * then by an approximate match that tolerates a few edited characters.
 *
 * The annotations live in a companion note `<file>.pdf.md`: a readable list
 * (one `[[file.pdf#page=N&highlight=ID]]` wiki link per highlight) and a
 * fenced JSON block that carries the annotations themselves. Only the region
 * between the two markers is ours; the rest of the note is the user's.
 *
 * Everything here is pure (no DOM, no pdf.js) so it is unit-tested directly.
 */

import { encodeWikiPath } from "../lib/wikiPath";

export { encodeWikiPath };

export const ANNO_CONTEXT = "http://www.w3.org/ns/anno.jsonld";
export const RFC3778 = "http://tools.ietf.org/rfc/rfc3778";

export interface TextQuoteSelector {
  type: "TextQuoteSelector";
  exact: string;
  prefix?: string;
  suffix?: string;
}

export interface TextPositionSelector {
  type: "TextPositionSelector";
  start: number;
  end: number;
}

export interface PdfFragmentSelector {
  type: "FragmentSelector";
  conformsTo: typeof RFC3778;
  /** `page=N`, optionally `&viewrect=left,top,width,height` in PDF points. */
  value: string;
  refinedBy: TextQuoteSelector | TextPositionSelector;
}

export interface TextualBody {
  type: "TextualBody";
  value: string;
  format: "text/plain";
  purpose: "commenting";
}

export interface PdfAnnotation {
  "@context": typeof ANNO_CONTEXT;
  id: string;
  type: "Annotation";
  motivation: "highlighting" | "commenting";
  created: string;
  modified?: string;
  body?: TextualBody[];
  target: {
    /** Vault path of the PDF. */
    source: string;
    /** Alternatives for the same text: the quote (first) and its position. */
    selector: PdfFragmentSelector[];
  };
}

/** A rectangle on a page, in PDF points from the top-left corner. */
export interface PageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/* ─── Selectors ───────────────────────────────────────────────────── */

/** Characters of context kept on each side of the quote. */
export const QUOTE_CONTEXT = 32;

/** The TextQuoteSelector for `text[start, end)`. */
export function createTextQuoteSelector(text: string, start: number, end: number, context = QUOTE_CONTEXT): TextQuoteSelector {
  const s = Math.max(0, Math.min(start, end));
  const e = Math.min(text.length, Math.max(start, end));
  const sel: TextQuoteSelector = { type: "TextQuoteSelector", exact: text.slice(s, e) };
  const prefix = text.slice(Math.max(0, s - context), s);
  const suffix = text.slice(e, e + context);
  if (prefix) sel.prefix = prefix;
  if (suffix) sel.suffix = suffix;
  return sel;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The union of `rects` (null for none). */
export function unionRect(rects: readonly PageRect[]): PageRect | null {
  if (!rects.length) return null;
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  for (const x of rects) {
    l = Math.min(l, x.left);
    t = Math.min(t, x.top);
    r = Math.max(r, x.left + x.width);
    b = Math.max(b, x.top + x.height);
  }
  return { left: round2(l), top: round2(t), width: round2(r - l), height: round2(b - t) };
}

/** RFC 3778 fragment for a page (1-based) and an optional box. */
export function pageFragment(page: number, rect?: PageRect | null): string {
  const p = `page=${Math.max(1, Math.floor(page))}`;
  if (!rect) return p;
  return `${p}&viewrect=${[rect.left, rect.top, rect.width, rect.height].map(round2).join(",")}`;
}

/** Parse `page=3&viewrect=…&highlight=…` (a leading `#` is fine). */
export function parsePdfFragment(fragment: string | null | undefined): { page: number | null; highlight: string | null; rect: PageRect | null } {
  const out: { page: number | null; highlight: string | null; rect: PageRect | null } = { page: null, highlight: null, rect: null };
  if (!fragment) return out;
  for (const part of fragment.replace(/^#/, "").split("&")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = decodeURIComponentSafe(part.slice(eq + 1).trim());
    if (key === "page") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) out.page = n;
    } else if (key === "highlight") {
      if (/^[\w-]+$/.test(value)) out.highlight = value;
    } else if (key === "viewrect") {
      const n = value.split(",").map(Number);
      if (n.length === 4 && n.every(Number.isFinite)) out.rect = { left: n[0], top: n[1], width: n[2], height: n[3] };
    }
  }
  return out;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Short id used in links: the first 8 hex digits of the annotation's uuid. */
export function shortId(id: string): string {
  return id.replace(/^urn:uuid:/, "").replace(/-/g, "").slice(0, 8);
}

/** Build a highlight annotation. */
export function createPdfAnnotation(opts: {
  id: string;
  source: string;
  page: number;
  text: string;
  start: number;
  end: number;
  rect?: PageRect | null;
  note?: string;
  now?: Date;
}): PdfAnnotation {
  const quote = createTextQuoteSelector(opts.text, opts.start, opts.end);
  const created = (opts.now ?? new Date()).toISOString();
  const a: PdfAnnotation = {
    "@context": ANNO_CONTEXT,
    id: opts.id.startsWith("urn:") ? opts.id : `urn:uuid:${opts.id}`,
    type: "Annotation",
    motivation: opts.note ? "commenting" : "highlighting",
    created,
    target: {
      source: opts.source,
      selector: [
        { type: "FragmentSelector", conformsTo: RFC3778, value: pageFragment(opts.page, opts.rect), refinedBy: quote },
        {
          type: "FragmentSelector",
          conformsTo: RFC3778,
          value: pageFragment(opts.page),
          refinedBy: { type: "TextPositionSelector", start: Math.min(opts.start, opts.end), end: Math.max(opts.start, opts.end) },
        },
      ],
    },
  };
  if (opts.note) a.body = [noteBody(opts.note)];
  return a;
}

function noteBody(value: string): TextualBody {
  return { type: "TextualBody", value, format: "text/plain", purpose: "commenting" };
}

/** A copy of `a` with its note set (an empty note removes it). */
export function withNote(a: PdfAnnotation, note: string, now: Date = new Date()): PdfAnnotation {
  const value = note.trim();
  const next: PdfAnnotation = { ...a, modified: now.toISOString(), motivation: value ? "commenting" : "highlighting" };
  if (value) next.body = [noteBody(value)];
  else delete next.body;
  return next;
}

/** What the reader needs from an annotation. */
export function describeAnnotation(a: PdfAnnotation): {
  page: number;
  quote: TextQuoteSelector | null;
  position: TextPositionSelector | null;
  rect: PageRect | null;
  note: string;
} {
  let page = 1;
  let quote: TextQuoteSelector | null = null;
  let position: TextPositionSelector | null = null;
  let rect: PageRect | null = null;
  for (const s of a.target.selector) {
    const f = parsePdfFragment(s.value);
    if (f.page) page = f.page;
    if (f.rect && !rect) rect = f.rect;
    if (s.refinedBy?.type === "TextQuoteSelector" && !quote) quote = s.refinedBy;
    if (s.refinedBy?.type === "TextPositionSelector" && !position) position = s.refinedBy;
  }
  const note = a.body?.find((b) => b.type === "TextualBody")?.value ?? "";
  return { page, quote, position, rect, note };
}

/* ─── Normalisation ───────────────────────────────────────────────── */

/**
 * Text folded for matching, with a map back to the original: `map[i]` is the
 * index in `text` of normalised character `i`, and `map[out.length]` is
 * `text.length`. Folds case, collapses whitespace runs to one space, and
 * drops what changes between text layers without changing the words: bidi
 * controls, zero-width characters, soft hyphens and Hebrew niqqud / cantillation.
 */
export function normalizeWithMap(text: string): { text: string; map: number[] } {
  let out = "";
  const map: number[] = [];
  let lastSpace = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/[֑-ׇ­​-‏‪-‮⁦-⁩﻿]/.test(ch)) continue;
    if (/\s/.test(ch)) {
      if (lastSpace) continue;
      out += " ";
      map.push(i);
      lastSpace = true;
      continue;
    }
    const folded = ch.toLowerCase();
    // toLowerCase can lengthen a character (İ → i̇); keep the map aligned.
    for (const f of folded) {
      out += f;
      map.push(i);
    }
    lastSpace = false;
  }
  if (out.endsWith(" ")) {
    out = out.slice(0, -1);
    map.pop();
  }
  map.push(text.length);
  return { text: out, map };
}

function normalizeQuote(s: string): string {
  return normalizeWithMap(s).text;
}

/* ─── Anchoring ───────────────────────────────────────────────────── */

export interface Anchor {
  start: number;
  end: number;
  /** "exact": the quote as written; "normalized": modulo spacing / case / marks; "fuzzy": approximate. */
  match: "exact" | "normalized" | "fuzzy";
}

/** Length of the common suffix of a and b. */
function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** Length of the common prefix of a and b. */
function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function contextScore(text: string, start: number, end: number, prefix: string, suffix: string): number {
  const before = text.slice(Math.max(0, start - prefix.length), start);
  const after = text.slice(end, end + suffix.length);
  return commonSuffix(before, prefix) + commonPrefix(after, suffix);
}

/** All indexes of `needle` in `hay` (overlapping). */
function indexesOf(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/** Pick the candidate whose context matches best; ties go to the one nearest `hint`. */
function best<T extends { start: number; end: number }>(cands: T[], score: (c: T) => number, hint: number | undefined): T | null {
  let pick: T | null = null;
  let pickScore = -Infinity;
  let pickDist = Infinity;
  for (const c of cands) {
    const s = score(c);
    const d = hint === undefined ? 0 : Math.abs(c.start - hint);
    if (s > pickScore || (s === pickScore && d < pickDist)) {
      pick = c;
      pickScore = s;
      pickDist = d;
    }
  }
  return pick;
}

/**
 * Edit-distance substring search (Sellers): the end positions in `text`
 * where `pattern` matches with at most `maxErr` edits, with their distance.
 */
function approxEnds(text: string, pattern: string, maxErr: number): { end: number; dist: number }[] {
  const m = pattern.length;
  let prev = new Array<number>(m + 1);
  let cur = new Array<number>(m + 1);
  for (let i = 0; i <= m; i++) prev[i] = i;
  const out: { end: number; dist: number }[] = [];
  for (let j = 1; j <= text.length; j++) {
    cur[0] = 0;
    const tc = text[j - 1];
    for (let i = 1; i <= m; i++) {
      const cost = pattern[i - 1] === tc ? 0 : 1;
      cur[i] = Math.min(prev[i - 1] + cost, prev[i] + 1, cur[i - 1] + 1);
    }
    if (cur[m] <= maxErr) out.push({ end: j, dist: cur[m] });
    [prev, cur] = [cur, prev];
  }
  return out;
}

/** Start of the best approximate match of `pattern` that ends at `end`. */
function approxStart(text: string, pattern: string, end: number, maxErr: number): number {
  const from = Math.max(0, end - pattern.length - maxErr);
  const window = text.slice(from, end);
  // Same search, reversed: the match ending at the window's end in reverse
  // is the one starting nearest the original start.
  const rev = (s: string) => Array.from(s).reverse().join("");
  const ends = approxEnds(rev(window), rev(pattern), maxErr);
  let bestEnd = pattern.length;
  let bestDist = Infinity;
  for (const e of ends) {
    if (e.dist < bestDist || (e.dist === bestDist && Math.abs(e.end - pattern.length) < Math.abs(bestEnd - pattern.length))) {
      bestDist = e.dist;
      bestEnd = e.end;
    }
  }
  return Math.max(0, end - bestEnd);
}

/** Shortest quote (normalised characters) that may be matched approximately. */
const FUZZY_MIN = 8;

/** Longest quote the approximate search runs on (it is O(text × quote)). */
const FUZZY_MAX = 256;

/**
 * Find a TextQuoteSelector's text in `text`. `hint` (the old start offset,
 * from a TextPositionSelector) breaks ties between equally good candidates.
 * Returns null when the quote can't be found, even approximately.
 */
export function anchorTextQuote(text: string, quote: TextQuoteSelector, hint?: number): Anchor | null {
  const prefix = quote.prefix ?? "";
  const suffix = quote.suffix ?? "";
  if (!quote.exact) return null;

  // 1. The quote as written.
  const exact = indexesOf(text, quote.exact).map((s) => ({ start: s, end: s + quote.exact.length }));
  if (exact.length) {
    const pick = best(exact, (c) => contextScore(text, c.start, c.end, prefix, suffix), hint);
    if (pick) return { ...pick, match: "exact" };
  }

  // 2. Modulo spacing, case, bidi controls and niqqud.
  const norm = normalizeWithMap(text);
  const nExact = normalizeQuote(quote.exact);
  if (!nExact) return null;
  const nPrefix = normalizeQuote(prefix);
  const nSuffix = normalizeQuote(suffix);
  const toOrig = (s: number, e: number) => ({ start: norm.map[s], end: e > 0 ? norm.map[e - 1] + 1 : norm.map[0] });
  const nHint = hint === undefined ? undefined : norm.map.findIndex((o) => o >= hint);
  const nCands = indexesOf(norm.text, nExact).map((s) => ({ start: s, end: s + nExact.length }));
  if (nCands.length) {
    const pick = best(nCands, (c) => contextScore(norm.text, c.start, c.end, nPrefix, nSuffix), nHint === -1 ? undefined : nHint);
    if (pick) return { ...toOrig(pick.start, pick.end), match: "normalized" };
  }

  // 3. Approximately: up to about 15% of the quote's characters edited. Not
  // for short quotes — one edit in a few characters matches almost anything.
  if (nExact.length < FUZZY_MIN) return null;
  if (nExact.length > FUZZY_MAX) {
    // A long quote: anchor its two ends separately.
    const head = anchorTextQuote(text, { type: "TextQuoteSelector", exact: quote.exact.slice(0, 64), prefix }, hint);
    const tail = anchorTextQuote(text, { type: "TextQuoteSelector", exact: quote.exact.slice(-64), suffix }, hint === undefined ? undefined : hint + quote.exact.length - 64);
    if (head && tail && tail.end > head.start && tail.end - head.start < quote.exact.length * 1.25) {
      return { start: head.start, end: tail.end, match: "fuzzy" };
    }
    return null;
  }
  const maxErr = Math.max(1, Math.round(nExact.length * 0.15));
  const ends = approxEnds(norm.text, nExact, maxErr);
  if (!ends.length) return null;
  // Neighbouring end positions describe the same match: one candidate per
  // run, the end with the fewest edits whose span is closest to the quote's length.
  const runs: { end: number; dist: number }[][] = [];
  for (const e of ends) {
    const run = runs[runs.length - 1];
    if (run && e.end === run[run.length - 1].end + 1) run.push(e);
    else runs.push([e]);
  }
  const cands = runs.map((run) => {
    let pick: { start: number; end: number; dist: number } | null = null;
    for (const e of run) {
      const start = approxStart(norm.text, nExact, e.end, maxErr);
      const off = Math.abs(e.end - start - nExact.length);
      if (!pick || e.dist < pick.dist || (e.dist === pick.dist && off < Math.abs(pick.end - pick.start - nExact.length))) {
        pick = { start, end: e.end, dist: e.dist };
      }
    }
    return pick!;
  });
  const minDist = Math.min(...cands.map((c) => c.dist));
  const closest = cands.filter((c) => c.dist === minDist);
  const pick = best(closest, (c) => contextScore(norm.text, c.start, c.end, nPrefix, nSuffix), nHint === -1 ? undefined : nHint);
  return pick ? { ...toOrig(pick.start, pick.end), match: "fuzzy" } : null;
}

/** Re-anchor an annotation in its page's current text. */
export function anchorAnnotation(a: PdfAnnotation, pageText: string): Anchor | null {
  const d = describeAnnotation(a);
  if (d.quote) return anchorTextQuote(pageText, d.quote, d.position?.start);
  if (d.position && d.position.end <= pageText.length) return { start: d.position.start, end: d.position.end, match: "exact" };
  return null;
}

/* ─── Search ──────────────────────────────────────────────────────── */

/** Every match of `query` in `text` (case / spacing / niqqud-insensitive), as original offsets. */
export function findAll(text: string, query: string): { start: number; end: number }[] {
  const q = normalizeQuote(query);
  if (!q) return [];
  const norm = normalizeWithMap(text);
  const out: { start: number; end: number }[] = [];
  for (let i = norm.text.indexOf(q); i !== -1; i = norm.text.indexOf(q, i + q.length)) {
    out.push({ start: norm.map[i], end: norm.map[i + q.length - 1] + 1 });
  }
  return out;
}

/**
 * The match to go to from match `current` (-1: none yet) in a list of
 * `length`, one step forward (1) or back (-1), wrapping. With no current
 * match, forward goes to the first and back to the last.
 */
export function nextMatchIndex(current: number, step: 1 | -1, length: number): number {
  if (length <= 0) return -1;
  if (current < 0 || current >= length) return step === 1 ? 0 : length - 1;
  return (current + step + length) % length;
}

/* ─── Companion note ──────────────────────────────────────────────── */

export const NOTE_START = "<!-- lumen:pdf-annotations:start -->";
export const NOTE_END = "<!-- lumen:pdf-annotations:end -->";
const JSON_INFO = "json lumen-pdf-annotations";

/** Vault path of the companion note of a PDF. */
export function companionNotePath(pdfPath: string): string {
  return `${pdfPath}.md`;
}


/** Wiki-link target that opens `pdfPath` at the highlight. */
export function highlightLinkTarget(pdfPath: string, a: PdfAnnotation): string {
  return `${encodeWikiPath(pdfPath)}#page=${describeAnnotation(a).page}&highlight=${shortId(a.id)}`;
}

/** One line of Markdown, with the characters that would start syntax escaped. */
function inlineText(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/([\\`*_[\]<>|#~])/g, "\\$1");
}

/** The annotations stored in a companion note (empty when there are none or the block is unreadable). */
export function parseAnnotationsNote(md: string | null | undefined): PdfAnnotation[] {
  if (!md) return [];
  const start = md.indexOf(NOTE_START);
  const region = start === -1 ? md : md.slice(start, md.indexOf(NOTE_END, start) === -1 ? undefined : md.indexOf(NOTE_END, start));
  const fence = /(`{3,}|~{3,})[ \t]*json[ \t]+lumen-pdf-annotations[^\n]*\n([\s\S]*?)\n\1/.exec(region);
  if (!fence) return [];
  try {
    const data = JSON.parse(fence[2]) as unknown;
    const list = Array.isArray(data) ? data : [];
    return list.filter(isPdfAnnotation);
  } catch {
    return [];
  }
}

/**
 * The annotations of a companion note, strictly: null when the note has a
 * highlights block that can't be read whole (a marker without its pair, a
 * fence cut short, JSON that doesn't parse, an entry that isn't an
 * annotation). Saving over such a block would erase what it held, so a
 * caller must not write then. No note, or a note without a block: [].
 */
export function readAnnotationsNote(md: string | null | undefined): PdfAnnotation[] | null {
  if (!md) return [];
  const start = md.indexOf(NOTE_START);
  const end = start === -1 ? -1 : md.indexOf(NOTE_END, start);
  const hasInfo = /^[ \t]*(`{3,}|~{3,})[ \t]*json[ \t]+lumen-pdf-annotations/m.test(md);
  if (start === -1 && !hasInfo) return [];
  if (start !== -1 && end === -1) return null;
  const region = start === -1 ? md : md.slice(start, end);
  const fence = /(`{3,}|~{3,})[ \t]*json[ \t]+lumen-pdf-annotations[^\n]*\n([\s\S]*?)\n\1/.exec(region);
  if (!fence) return null;
  try {
    const data = JSON.parse(fence[2]) as unknown;
    if (!Array.isArray(data) || !data.every(isPdfAnnotation)) return null;
    return data;
  } catch {
    return null;
  }
}

function isPdfAnnotation(x: unknown): x is PdfAnnotation {
  if (!x || typeof x !== "object") return false;
  const a = x as Partial<PdfAnnotation>;
  return (
    a.type === "Annotation" &&
    typeof a.id === "string" &&
    !!a.target &&
    typeof a.target.source === "string" &&
    Array.isArray(a.target.selector) &&
    a.target.selector.every((s) => !!s && s.type === "FragmentSelector" && typeof s.value === "string")
  );
}

/** Labels for the note, in the user's language. */
export interface NoteLabels {
  /** Title of a new note, e.g. "Highlights — paper.pdf". */
  title: string;
  /** Link label for page n, e.g. "p. {n}". */
  page: (n: number) => string;
  /** Shown when there are no highlights. */
  empty: string;
}

/** The managed region for `annotations` (sorted by page, then position). */
export function renderAnnotationsBlock(pdfPath: string, annotations: readonly PdfAnnotation[], labels: NoteLabels): string {
  const sorted = [...annotations].sort((a, b) => {
    const da = describeAnnotation(a);
    const db = describeAnnotation(b);
    return da.page - db.page || (da.position?.start ?? 0) - (db.position?.start ?? 0) || a.created.localeCompare(b.created);
  });
  const lines = sorted.map((a) => {
    const d = describeAnnotation(a);
    const quote = inlineText(d.quote?.exact ?? "");
    const note = d.note ? ` — ${inlineText(d.note)}` : "";
    return `- [[${highlightLinkTarget(pdfPath, a)}|${labels.page(d.page)}]] “${quote}”${note}`;
  });
  // `<` as \u003c (still the same JSON): a quote or note holding the end marker can't end the region early (review #272).
  const json = JSON.stringify(sorted, null, 2).replace(/</g, "\\u003c");
  // A fence longer than any backtick run in the JSON (a quote may hold ```).
  const longest = Math.max(2, ...Array.from(json.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return [NOTE_START, "", ...(lines.length ? lines : [labels.empty]), "", `${fence}${JSON_INFO}`, json, fence, "", NOTE_END].join("\n");
}

/**
 * The companion note with its managed region replaced by `annotations`.
 * Text outside the markers is kept as the user wrote it; a note without
 * markers gets the region appended, and a missing note is created.
 */
export function upsertAnnotationsNote(existing: string | null | undefined, pdfPath: string, annotations: readonly PdfAnnotation[], labels: NoteLabels): string {
  const block = renderAnnotationsBlock(pdfPath, annotations, labels);
  if (!existing || !existing.trim()) return `# ${labels.title}\n\n${block}\n`;
  const start = existing.indexOf(NOTE_START);
  const end = start === -1 ? -1 : existing.indexOf(NOTE_END, start);
  if (start !== -1 && end !== -1) return existing.slice(0, start) + block + existing.slice(end + NOTE_END.length);
  return `${existing.replace(/\s*$/, "")}\n\n${block}\n`;
}
