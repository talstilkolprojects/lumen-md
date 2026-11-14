/**
 * Markdown, cut into what a translator may touch and what it must not
 * (plan 6.4): frontmatter, fenced and indented code, HTML blocks, link
 * definitions and table rules are kept whole; inside a prose line, inline
 * code, math, link and image targets, wiki links, autolinks, bare URLs,
 * e-mail addresses, footnote marks and HTML tags are kept; the markers of
 * headings, lists, quotes and tables stay in place and only the words move.
 *
 * Protected spans are sent as placeholders ("{{3}}") so a sentence keeps
 * its context; if a translator drops or doubles one, that line is done
 * again run by run (each text run on its own, the protected spans never
 * sent at all). Either way the result is checked: every protected span is
 * in the output exactly as it was.
 *
 * Pure functions, no model: tested with a scripted translator.
 */

export interface Run {
  kind: "text" | "keep";
  text: string;
}

export interface Line {
  /** Markdown that stays untouched (block code, frontmatter, rules…), or null for a prose line. */
  keep: string | null;
  /** A prose line: its fixed prefix (marker) and its runs. */
  prefix: string;
  runs: Run[];
  /** Table rows: each cell is its own run list; `cells` is set instead of `runs`. */
  cells?: Run[][];
  /** The paragraph this line belongs to (consecutive prose lines), for language routing. */
  paragraph: number;
}

/** A translator for a batch of plain-text segments, in order. */
export type Translate = (texts: string[], signal?: AbortSignal) => Promise<string[]>;

export interface TranslateMarkdownOptions {
  /** Skip a paragraph (return false) — e.g. it is already in the target language (plan 6.5). */
  shouldTranslate?: (paragraphText: string) => boolean;
  /** Segments longer than this are translated sentence by sentence. */
  maxChars?: number;
  signal?: AbortSignal;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^(\s{0,3}#{1,6}\s+)(.*?)(\s+#+\s*)?$/;
const QUOTE = /^(\s{0,3}>\s?)/;
const LIST = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?)/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const LINK_DEF = /^\s{0,3}\[[^\]^][^\]]*\]:\s*\S+\s*$/;
const FOOTNOTE_DEF = /^(\s{0,3}\[\^[^\]]+\]:\s*)/;
const HTML_BLOCK = /^\s{0,3}<(?:[a-zA-Z][\w-]*|!--|\/[a-zA-Z])/;
const INDENTED_CODE = /^(?: {4}|\t)/;

/**
 * Inline spans that must survive verbatim, longest / most specific first.
 * Link text is translated: only "](target)" and "][ref]" are kept.
 */
const INLINE_KEEP = new RegExp(
  [
    /`{2}[^`]*`{2}|`[^`\n]*`/.source, // inline code
    /\$\$[^$\n]+\$\$|\$[^$\s][^$\n]*?\$/.source, // math
    /\[\[[^\]\n]+\]\]/.source, // wiki link
    /!\[/.source, // image opener (its alt is text, its target below)
    /\]\([^)\n]*\)|\]\[[^\]\n]*\]/.source, // link / image target or reference
    /\[\^[^\]\n]+\]/.source, // footnote mark
    /<(?:https?|mailto|ftp):[^>\s]+>/.source, // autolink
    /<\/?[a-zA-Z][^<>\n]*>/.source, // HTML tag
    /https?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"]/.source, // bare URL
    /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/.source, // e-mail
  ].join("|"),
  "g",
);

/** A prose line's text → text and keep runs. */
export function runsOf(text: string): Run[] {
  const runs: Run[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_KEEP)) {
    if (m.index! > last) runs.push({ kind: "text", text: text.slice(last, m.index) });
    runs.push({ kind: "keep", text: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) runs.push({ kind: "text", text: text.slice(last) });
  return runs;
}

function splitCells(row: string): { lead: string; cells: string[]; trail: string } {
  // Cells split on unescaped pipes; a leading / trailing pipe is kept as is.
  const lead = row.startsWith("|") ? "|" : "";
  const trail = row.length > 1 && row.endsWith("|") && !row.endsWith("\\|") ? "|" : "";
  const inner = row.slice(lead.length, row.length - trail.length);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && inner[i + 1] === "|") {
      cur += "\\|";
      i++;
    } else if (inner[i] === "|") {
      cells.push(cur);
      cur = "";
    } else cur += inner[i];
  }
  cells.push(cur);
  return { lead, cells, trail };
}

/** Markdown → lines. `lines.map(render).join("\n")` with untouched runs is the input. */
export function parseMarkdown(text: string): Line[] {
  const out: Line[] = [];
  const src = text.split("\n");
  let i = 0;
  let paragraph = 0;
  let inProse = false;
  const keep = (s: string) => {
    out.push({ keep: s, prefix: "", runs: [], paragraph: -1 });
    inProse = false;
  };
  // Frontmatter: only at the very top.
  if (src[0]?.trim() === "---") {
    const end = src.findIndex((l, k) => k > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) {
      for (; i <= end; i++) keep(src[i]);
    }
  }
  while (i < src.length) {
    const line = src[i];
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      keep(line);
      i++;
      while (i < src.length) {
        const l = src[i++];
        keep(l);
        const close = FENCE.exec(l);
        if (close && close[1][0] === marker[0] && close[1].length >= marker.length && l.trim() === close[1]) break;
      }
      continue;
    }
    if (line.trim() === "") {
      keep(line);
      i++;
      continue;
    }
    if (TABLE_RULE.test(line) || LINK_DEF.test(line) || HTML_BLOCK.test(line) || (INDENTED_CODE.test(line) && !inProse) || /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      keep(line);
      i++;
      continue;
    }
    if (!inProse) paragraph++;
    inProse = true;
    let rest = line;
    let prefix = "";
    // Quote markers can nest, then one heading or list marker.
    for (;;) {
      const q = QUOTE.exec(rest);
      if (!q) break;
      prefix += q[1];
      rest = rest.slice(q[1].length);
    }
    const h = HEADING.exec(rest);
    if (h) {
      out.push({ keep: null, prefix: prefix + h[1], runs: [...runsOf(h[2]), ...(h[3] ? [{ kind: "keep" as const, text: h[3] }] : [])], paragraph });
      i++;
      continue;
    }
    const f = FOOTNOTE_DEF.exec(rest);
    const l = f ? null : LIST.exec(rest);
    if (f) {
      prefix += f[1];
      rest = rest.slice(f[1].length);
    } else if (l) {
      prefix += l[1];
      rest = rest.slice(l[1].length);
    }
    const trimmedStart = /^\s*/.exec(rest)![0];
    if (trimmedStart && !l) {
      prefix += trimmedStart;
      rest = rest.slice(trimmedStart.length);
    }
    if (rest.includes("|") && (rest.trim().startsWith("|") || (i + 1 < src.length && TABLE_RULE.test(src[i + 1])) || (out.length && out[out.length - 1].cells))) {
      const { lead, cells, trail } = splitCells(rest.trim());
      out.push({ keep: null, prefix: prefix + lead, runs: [{ kind: "keep", text: trail }], cells: cells.map(runsOf), paragraph });
      i++;
      continue;
    }
    out.push({ keep: null, prefix, runs: runsOf(rest), paragraph });
    i++;
  }
  return out;
}

export function renderLine(line: Line): string {
  if (line.keep !== null) return line.keep;
  if (line.cells) return line.prefix + line.cells.map((c) => c.map((r) => r.text).join("")).join("|") + line.runs.map((r) => r.text).join("");
  return line.prefix + line.runs.map((r) => r.text).join("");
}

const PLACEHOLDER = (n: number) => `{{${n}}}`;
const PLACEHOLDER_RE = /\{\{(\d+)\}\}/g;

/** Split a long segment into sentences (Latin, Hebrew, Arabic, CJK stops). */
export function sentencesOf(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const parts = text.split(/(?<=[.!?…。！？؟])\s+/).filter((p) => p.length);
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    if (cur && (cur + " " + p).length > maxChars) {
      out.push(cur);
      cur = p;
    } else cur = cur ? cur + " " + p : p;
  }
  if (cur) out.push(cur);
  return out;
}

interface Pending {
  line: Line;
  cell?: number;
  runs: Run[];
}

interface Keep {
  text: string;
  /** The source had a word boundary (space, start / end of line) on that side. */
  spaceBefore: boolean;
  spaceAfter: boolean;
}

/** Every text run of a run list, as one placeholder string (null when the line has no words). */
function placeholderText(runs: Run[]): { text: string; keeps: Keep[] } | null {
  const keeps: Keep[] = [];
  let text = "";
  runs.forEach((r, i) => {
    if (r.kind === "keep") {
      const prev = runs[i - 1]?.text ?? "";
      const next = runs[i + 1]?.text ?? "";
      keeps.push({ text: r.text, spaceBefore: !prev || /\s$/.test(prev), spaceAfter: !next || /^\s/.test(next) });
      text += PLACEHOLDER(keeps.length - 1);
    } else text += r.text;
  });
  if (!/\p{L}/u.test(runs.filter((r) => r.kind === "text").map((r) => r.text).join(""))) return null;
  return { text, keeps };
}

const WORDISH = /[\p{L}\p{N}]/u;

/**
 * Put the kept spans back; null when the translator did not return each
 * placeholder exactly once. A translator may move a placeholder next to a
 * word: where the source had a boundary, one is kept, so a bare URL, a
 * wiki link or an address does not end up glued to a word.
 */
function restorePlaceholders(translated: string, keeps: Keep[]): string | null {
  const seen = new Map<number, number>();
  for (const m of translated.matchAll(PLACEHOLDER_RE)) seen.set(Number(m[1]), (seen.get(Number(m[1])) ?? 0) + 1);
  if (seen.size !== keeps.length) return null;
  for (let n = 0; n < keeps.length; n++) if (seen.get(n) !== 1) return null;
  return translated.replace(PLACEHOLDER_RE, (_, n, offset: number, whole: string) => {
    const k = keeps[Number(n)];
    const before = whole[offset - 1] ?? "";
    const after = whole[offset + (_ as string).length] ?? "";
    const lead = k.spaceBefore && before && WORDISH.test(before) ? " " : "";
    const trail = k.spaceAfter && after && WORDISH.test(after) ? " " : "";
    return lead + k.text + trail;
  });
}

/** Leading / trailing whitespace, kept around a translated segment. */
function pad(original: string, translated: string): string {
  const lead = /^\s*/.exec(original)![0];
  const trail = /\s*$/.exec(original)![0];
  return lead + translated.trim() + trail;
}

/**
 * Translate a Markdown document with `translate`, keeping everything a
 * translator must not change. Throws when a kept span would not survive
 * (never, by construction, but checked: the caller may rely on it).
 */
export async function translateMarkdown(text: string, translate: Translate, opts: TranslateMarkdownOptions = {}): Promise<string> {
  const maxChars = opts.maxChars ?? 600;
  const lines = parseMarkdown(text);
  // Paragraph routing (plan 6.5): a paragraph already in the target language stays.
  const skipped = new Set<number>();
  if (opts.shouldTranslate) {
    const byParagraph = new Map<number, string[]>();
    for (const l of lines) {
      if (l.keep !== null) continue;
      const words = (l.cells ? l.cells.flat() : l.runs).filter((r) => r.kind === "text").map((r) => r.text).join(" ");
      byParagraph.set(l.paragraph, [...(byParagraph.get(l.paragraph) ?? []), words]);
    }
    for (const [p, ws] of byParagraph) if (!opts.shouldTranslate(ws.join("\n"))) skipped.add(p);
  }
  const units: Pending[] = [];
  for (const l of lines) {
    if (l.keep !== null || skipped.has(l.paragraph)) continue;
    if (l.cells) l.cells.forEach((runs, cell) => units.push({ line: l, cell, runs }));
    else units.push({ line: l, runs: l.runs });
  }
  // Pass 1: placeholders. A unit whose text already looks like a placeholder goes straight to pass 2.
  const pass1: { unit: Pending; keeps: Keep[]; original: string; pieces: string[] }[] = [];
  const pass2: Pending[] = [];
  const batch: string[] = [];
  for (const unit of units) {
    const ph = placeholderText(unit.runs);
    if (!ph) continue;
    if (unit.runs.some((r) => r.kind === "text" && /\{\{\d+\}\}/.test(r.text))) {
      pass2.push(unit);
      continue;
    }
    const pieces = sentencesOf(ph.text, maxChars);
    pass1.push({ unit, keeps: ph.keeps, original: ph.text, pieces });
    batch.push(...pieces);
  }
  const translated1 = batch.length ? await translate(batch, opts.signal) : [];
  if (translated1.length !== batch.length) throw new Error(`translator returned ${translated1.length} segments for ${batch.length}`);
  let at = 0;
  for (const { unit, keeps, original, pieces } of pass1) {
    const joined = translated1.slice(at, at + pieces.length).join(" ");
    at += pieces.length;
    const restored = restorePlaceholders(joined, keeps);
    if (restored === null) {
      pass2.push(unit);
      continue;
    }
    setUnit(unit, [{ kind: "text", text: pad(original, restored) }]);
  }
  // Pass 2: each text run alone; kept runs are not sent at all.
  if (pass2.length) {
    const batch2: string[] = [];
    const plan: { unit: Pending; run: number; original: string; pieces: string[] }[] = [];
    for (const unit of pass2) {
      unit.runs.forEach((r, k) => {
        if (r.kind !== "text" || !/\p{L}/u.test(r.text)) return;
        const pieces = sentencesOf(r.text, maxChars);
        plan.push({ unit, run: k, original: r.text, pieces });
        batch2.push(...pieces);
      });
    }
    const translated2 = batch2.length ? await translate(batch2, opts.signal) : [];
    if (translated2.length !== batch2.length) throw new Error(`translator returned ${translated2.length} segments for ${batch2.length}`);
    let at2 = 0;
    for (const { unit, run, original, pieces } of plan) {
      const joined = translated2.slice(at2, at2 + pieces.length).join(" ");
      at2 += pieces.length;
      unit.runs[run] = { kind: "text", text: pad(original, joined) };
    }
  }
  const out = lines.map(renderLine).join("\n");
  // The contract, checked: every kept span of the source is in the output.
  const missing = keptSpans(text).filter((s) => !out.includes(s));
  if (missing.length) throw new Error(`translation lost ${missing.length} protected span(s): ${missing[0].slice(0, 60)}`);
  return out;
}

function setUnit(unit: Pending, runs: Run[]): void {
  if (unit.cell !== undefined) unit.line.cells![unit.cell] = runs;
  else unit.line.runs = runs;
}

/** Every span translateMarkdown keeps verbatim: block lines and inline keeps. */
export function keptSpans(text: string): string[] {
  const out: string[] = [];
  for (const l of parseMarkdown(text)) {
    if (l.keep !== null) {
      if (l.keep.trim()) out.push(l.keep);
      continue;
    }
    for (const r of l.cells ? l.cells.flat() : l.runs) if (r.kind === "keep" && r.text.trim()) out.push(r.text);
  }
  return out;
}
