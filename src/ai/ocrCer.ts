/**
 * Character error rate (CER) for the on-device OCR (plan 7.5).
 *
 * Pure functions, no DOM: used by the unit test (src/__tests__/ocrCer.test.ts)
 * and by the CI measurement against the golden set ocr-he
 * (e2e/ocr-cer.spec.ts, .github/workflows/ci.yml job `ocr-cer`).
 *
 * CER = Levenshtein distance between the reference and the OCR output,
 * counted in grapheme clusters (Intl.Segmenter), divided by the reference's
 * length. A corpus CER is the sum of the edits over the sum of the
 * reference lengths (not a mean of per-item rates), so a long page weighs
 * more than a short line.
 *
 * Normalisation, applied to both sides alike:
 *  - Unicode NFD → (optional) nikud removal → NFC, so canonical order of the
 *    points does not count and the precomposed presentation forms
 *    (U+FB1D–FB4F, e.g. שׁ) equal their decomposed letters;
 *  - bidi controls (LRM, RLM, embeddings, isolates, ALM) removed — tesseract
 *    wraps Latin runs inside Hebrew lines in them;
 *  - typographic variants of the same mark folded: gershayim ״ and curly
 *    double quotes → ", geresh ׳ and curly single quotes → ', maqaf ־ and
 *    en/em/figure dashes and minus → -;
 *  - every run of white space (line breaks included) → one space; ends trimmed.
 *    Line breaks are layout, not characters the reader reads.
 *
 * Hebrew final letters (ך ם ן ף ץ) stay distinct letters: מ for ם is an
 * error. With `stripNikud`, the points and cantillation marks are removed
 * (the gated metric); without it each letter with its points is one grapheme
 * and a wrong point is one substitution (the nikud metric, reported only).
 *
 * Per-script CER ("he" / "en"): the whole line is aligned once (one minimal
 * edit script), and each edit is charged to the script of the reference text
 * it touches — a substitution or deletion to its reference grapheme's script,
 * an insertion to the nearest reference letter before it (after it at the
 * start). A script's length is the number of its letters in the reference
 * (Hebrew letters; Latin letters). So "Bluetooth" read as Hebrew shapes is
 * nine English errors, and Latin noise read out of a Hebrew sentence is a
 * Hebrew error. Digits, punctuation and spaces belong to neither script and
 * count in "all" only.
 */

export type CerScript = "he" | "en";
/**
 * Conditions of the golden set ocr-he: rendered clean / degraded / nikud
 * lines and pages (plan 7.1), and the owner's phone photos of printed pages
 * (scripts/golden/owner.mjs, plan 15.11).
 */
export const OCR_CONDITIONS = ["clean", "degraded", "nikud", "photo"] as const;
export type OcrCondition = (typeof OCR_CONDITIONS)[number];
export type GatedCondition = "clean" | "degraded";

/**
 * Gated maximum CER per condition (plan 7.5). Nikud lines and the owner's
 * photos are reported only: plan 7.5 sets no threshold for them.
 */
export const OCR_CER_GATES: Readonly<Record<GatedCondition, number>> = { clean: 0.05, degraded: 0.12 };

export interface CerOptions {
  /** Remove Hebrew points and cantillation marks before comparing. */
  stripNikud?: boolean;
}

/** Hebrew points and cantillation marks (not maqaf, paseq, sof pasuq or nun hafukha, which are punctuation). */
const NIKUD_RE = /[֑-ׇֽֿׁׂׅׄ]/g;
const BIDI_RE = /[؜‎‏‪-‮⁦-⁩]/g;
const FOLD: ReadonlyArray<readonly [RegExp, string]> = [
  [/[״“”„‟]/g, '"'],
  [/[׳‘’‚‛]/g, "'"],
  [/[־‐‑‒–—−]/g, "-"],
];

export function normalizeForCer(text: string, opts: CerOptions = {}): string {
  let s = text.normalize("NFD");
  if (opts.stripNikud) s = s.replace(NIKUD_RE, "");
  s = s.replace(BIDI_RE, "");
  for (const [re, to] of FOLD) s = s.replace(re, to);
  return s.normalize("NFC").replace(/\s+/gu, " ").trim();
}

let segmenter: Intl.Segmenter | null = null;

/** Grapheme clusters of `text` (a letter with its points is one). */
export function graphemes(text: string): string[] {
  segmenter ??= new Intl.Segmenter("he", { granularity: "grapheme" });
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** Edit distance (insertions, deletions, substitutions; each costs 1). */
export function levenshtein(a: readonly string[], b: readonly string[]): number {
  if (a.length < b.length) return levenshtein(b, a);
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ai = a[i - 1];
    for (let j = 1; j <= b.length; j++) {
      const sub = (prev[j - 1] ?? 0) + (ai === b[j - 1] ? 0 : 1);
      cur[j] = Math.min(sub, (prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length] ?? 0;
}

/** The script of a grapheme, by its first (base) code point. */
export function scriptOf(g: string): CerScript | null {
  const c = g.codePointAt(0) ?? 0;
  if ((c >= 0x05d0 && c <= 0x05ea) || (c >= 0xfb1d && c <= 0xfb4f)) return "he";
  if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) return "en";
  return null;
}

export interface CerCount {
  /** Edit operations. */
  edits: number;
  /** Reference length in graphemes. */
  length: number;
  /** Items counted. */
  items: number;
}

export interface ItemCer {
  /** Every grapheme, nikud removed (the gated text metric). */
  all: CerCount;
  /** Every grapheme with its points (meaningful for nikud lines). */
  allNikud: CerCount;
  he: CerCount;
  en: CerCount;
}

const count = (ref: string[], hyp: string[]): CerCount => ({ edits: levenshtein(ref, hyp), length: ref.length, items: ref.length > 0 ? 1 : 0 });

/**
 * One minimal alignment of `ref` to `hyp`: for each edit, the index of the
 * reference grapheme it is charged to (an insertion: the reference position
 * it precedes, `ref.length` at the end). Its length equals levenshtein().
 */
export function alignEdits(ref: readonly string[], hyp: readonly string[]): Array<{ op: "sub" | "del" | "ins"; at: number }> {
  const n = ref.length;
  const m = hyp.length;
  const w = m + 1;
  const d = new Uint32Array((n + 1) * w);
  for (let i = 0; i <= n; i++) d[i * w] = i;
  for (let j = 0; j <= m; j++) d[j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = (d[(i - 1) * w + j - 1] ?? 0) + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      d[i * w + j] = Math.min(sub, (d[(i - 1) * w + j] ?? 0) + 1, (d[i * w + j - 1] ?? 0) + 1);
    }
  }
  const edits: Array<{ op: "sub" | "del" | "ins"; at: number }> = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const here = d[i * w + j] ?? 0;
    if (i > 0 && j > 0 && (d[(i - 1) * w + j - 1] ?? 0) + (ref[i - 1] === hyp[j - 1] ? 0 : 1) === here) {
      if (ref[i - 1] !== hyp[j - 1]) edits.push({ op: "sub", at: i - 1 });
      i--;
      j--;
    } else if (i > 0 && (d[(i - 1) * w + j] ?? 0) + 1 === here) {
      edits.push({ op: "del", at: i - 1 });
      i--;
    } else {
      edits.push({ op: "ins", at: i });
      j--;
    }
  }
  return edits.reverse();
}

/** The script an edit at reference position `at` is charged to (see the header). */
function chargedScript(ref: readonly string[], op: "sub" | "del" | "ins", at: number): CerScript | null {
  if (op !== "ins") return scriptOf(ref[at] ?? "");
  for (let k = at - 1; k >= 0; k--) {
    const s = scriptOf(ref[k] ?? "");
    if (s) return s;
  }
  for (let k = at; k < ref.length; k++) {
    const s = scriptOf(ref[k] ?? "");
    if (s) return s;
  }
  return null;
}

/** CER counts of one OCR result against its reference text. */
export function measureItem(reference: string, hypothesis: string): ItemCer {
  const ref = graphemes(normalizeForCer(reference, { stripNikud: true }));
  const hyp = graphemes(normalizeForCer(hypothesis, { stripNikud: true }));
  const edits = alignEdits(ref, hyp);
  const perScript = (s: CerScript): CerCount => {
    const length = ref.filter((g) => scriptOf(g) === s).length;
    // An item without that script in its reference does not count for it.
    if (!length) return emptyCount();
    return { edits: edits.filter((e) => chargedScript(ref, e.op, e.at) === s).length, length, items: 1 };
  };
  return {
    all: { edits: edits.length, length: ref.length, items: ref.length > 0 ? 1 : 0 },
    allNikud: count(graphemes(normalizeForCer(reference)), graphemes(normalizeForCer(hypothesis))),
    he: perScript("he"),
    en: perScript("en"),
  };
}

export const emptyCount = (): CerCount => ({ edits: 0, length: 0, items: 0 });

export function addCount(a: CerCount, b: CerCount): CerCount {
  return { edits: a.edits + b.edits, length: a.length + b.length, items: a.items + b.items };
}

/** Corpus CER; null when nothing was counted (no reference text of that kind). */
export function cer(c: CerCount): number | null {
  return c.length > 0 ? c.edits / c.length : null;
}

export interface CerItemInput {
  id: string;
  condition: OcrCondition;
  reference: string;
  hypothesis: string;
}

export type CerMetric = keyof ItemCer;

export interface CerReport {
  /** condition → metric → counts */
  byCondition: Record<OcrCondition, Record<CerMetric, CerCount>>;
  items: Array<{ id: string; condition: OcrCondition; cer: ItemCer }>;
}

export function buildReport(inputs: readonly CerItemInput[]): CerReport {
  const blank = (): Record<CerMetric, CerCount> => ({ all: emptyCount(), allNikud: emptyCount(), he: emptyCount(), en: emptyCount() });
  const byCondition: CerReport["byCondition"] = { clean: blank(), degraded: blank(), nikud: blank(), photo: blank() };
  const items: CerReport["items"] = [];
  for (const it of inputs) {
    // An item of a condition the report does not know is an error, never dropped.
    if (!(OCR_CONDITIONS as readonly string[]).includes(it.condition)) throw new Error(`OCR CER: item ${it.id} has an unknown condition "${String(it.condition)}"`);
    const m = measureItem(it.reference, it.hypothesis);
    items.push({ id: it.id, condition: it.condition, cer: m });
    const agg = byCondition[it.condition];
    for (const k of Object.keys(agg) as CerMetric[]) agg[k] = addCount(agg[k], m[k]);
  }
  return { byCondition, items };
}

export interface GateResult {
  condition: GatedCondition;
  script: CerScript;
  cer: number | null;
  max: number;
  /** "pass" | "fail" | "none" (no reference text of that script in that condition: nothing to gate). */
  verdict: "pass" | "fail" | "none";
}

/** Hebrew and English CER, nikud removed, against the gates — each script separately. */
export function checkGates(report: CerReport): GateResult[] {
  const out: GateResult[] = [];
  for (const condition of Object.keys(OCR_CER_GATES) as Array<keyof typeof OCR_CER_GATES>) {
    const max = OCR_CER_GATES[condition];
    for (const script of ["he", "en"] as const) {
      const v = cer(report.byCondition[condition][script]);
      out.push({ condition, script, cer: v, max, verdict: v === null ? "none" : v <= max ? "pass" : "fail" });
    }
  }
  return out;
}

const pct = (v: number | null): string => (v === null ? "—" : `${(v * 100).toFixed(2)}%`);

/** A Markdown table of the report (per condition: Hebrew, English, all; nikud with points too). */
export function formatReport(report: CerReport, title: string): string {
  const gates = checkGates(report);
  const gateCell = (c: OcrCondition, s: CerScript) => {
    const g = gates.find((x) => x.condition === c && x.script === s);
    return g ? ` (≤ ${(g.max * 100).toFixed(0)}%: ${g.verdict === "none" ? "no text" : g.verdict.toUpperCase()})` : " (reported only)";
  };
  const row = (c: OcrCondition) => {
    const m = report.byCondition[c];
    const cell = (k: CerMetric) => `${pct(cer(m[k]))} · ${m[k].edits}/${m[k].length} in ${m[k].items}`;
    return `| ${c} | ${cell("he")}${gateCell(c, "he")} | ${cell("en")}${gateCell(c, "en")} | ${cell("all")} | ${c === "nikud" ? cell("allNikud") : "—"} |`;
  };
  return [
    `### ${title}`,
    "",
    "CER = edits / reference graphemes (in N items). Hebrew and English: that script's letters only, nikud removed.",
    "",
    "| Condition | Hebrew | English | All characters | With nikud |",
    "|---|---|---|---|---|",
    row("clean"),
    row("degraded"),
    row("nikud"),
    row("photo"),
  ].join("\n");
}

/**
 * Why a held-out split may not be scored: a part with fewer items than the
 * manifest's test count (a builder failed, or the owner's bundle is absent —
 * golden-sets.yml continues past both), or a part whose sha256 is not
 * recorded yet. A partial or unverified split is never reported as the test
 * score. `incomplete` is scripts/lib/golden.mjs incompleteParts();
 * `unverified` is loadSet()'s list.
 *
 * `recordRun`: the run that records the hashes (golden-sets.yml task=test
 * record=true). Its parts are complete but, by definition, not recorded
 * yet — refusing them would mean the hashes can never be recorded (Codex P1
 * on #278) — so only a short part is a gap there; the unverified parts are
 * named in the report instead.
 */
export function heldOutGaps(
  incomplete: ReadonlyArray<{ part: string; have: number; want: number }>,
  unverified: readonly string[],
  { recordRun = false }: { recordRun?: boolean } = {},
): string[] {
  return [
    ...incomplete.map((x) => `part ${x.part}: ${x.have} of ${x.want} test items`),
    ...(recordRun ? [] : unverified.map((p) => `part ${p}: no recorded sha256 (record it with golden-sets.yml task=test record=true)`)),
  ];
}
