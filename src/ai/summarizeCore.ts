/**
 * Plan 6.11 — layered local summaries: the pure parts (no imports).
 *
 * A summary here is *grounded*: every sentence is copied from the source,
 * possibly shortened with "…" where words were cut — so each one can be
 * checked against the source word for word (`quoteContained`, the research
 * citations rule) and a sentence that isn't there is never shown.
 */

/** Sentences of a text (Latin, Hebrew, Arabic and CJK end marks; a blank line ends one too). */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const flat = block.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/gm, "").replace(/\s+/g, " ").trim();
    if (!flat) continue;
    for (const s of flat.split(/(?<!\b(?:Mr|Mrs|Ms|Dr|St|Sr|Jr|vs|etc|e\.g|i\.e|U\.S|No)\.)(?<=[.!?。！？؟])\s+(?=[\p{Lu}\p{Lo}"“'(\d])/u)) {
      const t = s.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/** Sentences of a model's summary: one per line, or split by end marks; list bullets removed. */
export function summarySentences(summary: string): string[] {
  const lines = summary
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, "").trim())
    .filter(Boolean);
  return lines.flatMap((l) => splitSentences(l));
}

/**
 * Sections for the layers: whole paragraphs packed up to `maxChars` (a
 * paragraph longer than that is cut between sentences).
 */
export function sections(text: string, maxChars = 6000): string[] {
  const paras: string[] = [];
  for (const p of text.split(/\n\s*\n/)) {
    if (p.length <= maxChars) {
      if (p.trim()) paras.push(p.trim());
      continue;
    }
    let cur = "";
    for (const s of splitSentences(p)) {
      if (cur && cur.length + s.length + 1 > maxChars) {
        paras.push(cur);
        cur = "";
      }
      cur = cur ? `${cur} ${s}` : s;
    }
    if (cur) paras.push(cur);
  }
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > maxChars) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}

const STOP = new Set(
  "the a an of to in and or is are was were be been it its that this these those for on with as by at from which who whom what how not but have has had will would shall should can could may might there their they them we our us you your he his she her i my me all any so than then also such into upon over more most other some no nor only own same too very".split(" ").concat("של את על עם זה זו זאת הוא היא הם הן מה מי כי גם או אם לא אך אבל כל יש אין עוד כמו בין אחר".split(" ")),
);

function words(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/**
 * The extractive layer — no model: the `n` sentences that carry the text's
 * most frequent content words, in their original order. Always grounded.
 */
export function extractiveSummary(text: string, n = 5): string[] {
  const sents = splitSentences(text).filter((s) => s.length >= 25 && s.length <= 600);
  if (sents.length <= n) return sents;
  const freq = new Map<string, number>();
  for (const s of sents) for (const w of new Set(words(s))) freq.set(w, (freq.get(w) ?? 0) + 1);
  const scored = sents.map((s, i) => {
    const ws = words(s);
    const score = ws.length ? ws.reduce((a, w) => a + (freq.get(w) ?? 0), 0) / Math.sqrt(ws.length) : 0;
    // A little weight for the opening, where the topic is usually stated.
    return { i, s, score: score * (i === 0 ? 1.2 : 1) };
  });
  const picked: typeof scored = [];
  for (const c of [...scored].sort((a, b) => b.score - a.score || a.i - b.i)) {
    if (picked.length >= n) break;
    // Skip a near-repeat of a sentence already picked.
    const cw = new Set(words(c.s));
    if (picked.some((p) => overlap(cw, new Set(words(p.s))) > 0.7)) continue;
    picked.push(c);
  }
  return picked.sort((a, b) => a.i - b.i).map((p) => p.s);
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / Math.min(a.size, b.size);
}

export interface Grounding {
  /** Sentences found in the source. */
  kept: string[];
  /** Sentences that aren't (never shown). */
  dropped: string[];
  /** kept / all, before anything was dropped (1 for an empty summary). */
  rate: number;
}

/** Check each summary sentence against the source with `contained` (quoteContained). */
export function ground(sentences: readonly string[], source: string, contained: (quote: string, source: string) => boolean): Grounding {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const s of sentences) (contained(s, source) ? kept : dropped).push(s);
  return { kept, dropped, rate: sentences.length ? kept.length / sentences.length : 1 };
}
