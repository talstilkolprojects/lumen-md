/**
 * HebOCRBench submission kit (plan W7.12): the external Hebrew OCR benchmark
 * (huggingface.co/datasets/ssdataanalysis/hebocrbench-v1). Its gold answers
 * stay with the organisers, so a score there can't be one we tuned for.
 *
 * Pure logic only (scripts/ocr/hebocrbench.mjs does the I/O and runs the app's
 * OCR): which track an input image belongs to, the prediction lines, the
 * submission's metadata, the check that no package image reached the repo or
 * dist, the published score record, the internal/external gap rule, and the
 * bidi track's regression checks for W5.4 (direction marks) and W5.5
 * (reversed Hebrew).
 */

export const HOB_TRACKS = [
  { id: "bidi", images: 192, metric: "CER" },
  { id: "lines", images: 28_414, metric: "CER" },
  { id: "pages", images: 700, metric: "CER" },
  { id: "tables", images: 61, metric: "CER" },
  { id: "robustness", images: 4_900, metric: "CER" },
] as const;

export type HobTrack = (typeof HOB_TRACKS)[number]["id"];

/** 34,267: the public input package. */
export const HOB_TOTAL_IMAGES = HOB_TRACKS.reduce((n, t) => n + t.images, 0);

const ALIASES: Readonly<Record<string, HobTrack>> = {
  bidi: "bidi", bidirectional: "bidi", mixed: "bidi",
  line: "lines", lines: "lines",
  page: "pages", pages: "pages", document: "pages", documents: "pages",
  table: "tables", tables: "tables",
  robust: "robustness", robustness: "robustness", noise: "robustness", degraded: "robustness",
};

export const IMAGE_EXT = /\.(png|jpe?g|tiff?|webp|bmp)$/i;

/** The track of a package path (`lines/000123.png`, `HebOCRBench/Tables/t-01.jpg`), or null. */
export function trackOf(path: string): HobTrack | null {
  for (const part of path.split(/[\\/]/).slice(0, -1).reverse()) {
    const t = ALIASES[part.toLowerCase().replace(/[^a-z]/g, "")];
    if (t) return t;
  }
  return null;
}

export interface HobItem {
  track: HobTrack;
  /** The image's path inside its track folder, without the extension: the id the organisers match on. */
  id: string;
  path: string;
}

/** Every image of the package, by track, in a stable order. Paths outside any track are reported. */
export function listPackage(paths: readonly string[]): { items: HobItem[]; unknown: string[]; perTrack: Record<HobTrack, number> } {
  const items: HobItem[] = [];
  const unknown: string[] = [];
  const perTrack = Object.fromEntries(HOB_TRACKS.map((t) => [t.id, 0])) as Record<HobTrack, number>;
  for (const path of [...paths].sort()) {
    if (!IMAGE_EXT.test(path)) continue;
    const track = trackOf(path);
    if (!track) {
      unknown.push(path);
      continue;
    }
    const parts = path.split(/[\\/]/);
    const at = parts.map((p) => ALIASES[p.toLowerCase().replace(/[^a-z]/g, "")]).lastIndexOf(track);
    const id = parts.slice(at + 1).join("/").replace(IMAGE_EXT, "");
    items.push({ track, id, path });
    perTrack[track]++;
  }
  return { items, unknown, perTrack };
}

/** Does the package hold what the organisers published? A partial run is labelled as one. */
export function packageCoverage(perTrack: Readonly<Record<HobTrack, number>>): Array<{ track: HobTrack; found: number; expected: number; complete: boolean }> {
  return HOB_TRACKS.map((t) => ({ track: t.id, found: perTrack[t.id] ?? 0, expected: t.images, complete: (perTrack[t.id] ?? 0) === t.images }));
}

/** The 12 invisible direction marks W5.4 shows: LRM, RLM, ALM, the embeddings, overrides and isolates. */
export const DIRECTION_MARKS = /[‎‏؜‪-‮⁦-⁩]/g;

export interface PredictionOptions {
  /** Keep direction marks in the prediction (default: removed; OCR can't see them). */
  keepMarks?: boolean;
}

/** One prediction as submitted: NFC, logical order, no direction marks, line ends normalised, trimmed. */
export function normalizePrediction(text: string, opts: PredictionOptions = {}): string {
  let t = text.normalize("NFC").replace(/\r\n?/g, "\n");
  if (!opts.keepMarks) t = t.replace(DIRECTION_MARKS, "");
  return t
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

export interface PredictionRecord {
  id: string;
  track: HobTrack;
  prediction: string;
}

/** One JSONL line of `predictions/<track>.jsonl`. */
export function predictionLine(item: Pick<HobItem, "id" | "track">, text: string, opts?: PredictionOptions): string {
  const rec: PredictionRecord = { id: item.id, track: item.track, prediction: normalizePrediction(text, opts) };
  return JSON.stringify(rec);
}

export interface SubmissionMeta {
  system: "lumen-md";
  version: string;
  commit: string;
  /** UTC date of the run, YYYY-MM-DD. */
  date: string;
  engine: string;
  /** sha256 of each model file the run used. */
  models: Record<string, string>;
  tracks: Array<{ track: HobTrack; predictions: number; expected: number }>;
  /** Plain words: what the kit did and didn't do. */
  notes: string[];
}

export function submissionMeta(m: Omit<SubmissionMeta, "system" | "tracks" | "notes"> & { perTrack: Readonly<Record<HobTrack, number>>; notes?: string[] }): SubmissionMeta {
  const missing = packageCoverage(m.perTrack).filter((c) => !c.complete);
  const notes = [...(m.notes ?? [])];
  if (missing.length) notes.push(`partial run: ${missing.map((c) => `${c.track} ${c.found}/${c.expected}`).join(", ")}`);
  return {
    system: "lumen-md",
    version: m.version,
    commit: m.commit,
    date: m.date,
    engine: m.engine,
    models: m.models,
    tracks: HOB_TRACKS.map((t) => ({ track: t.id, predictions: m.perTrack[t.id] ?? 0, expected: t.images })),
    notes,
  };
}

/** A path is inside a directory (the repo): the package must never be. */
export function isInside(path: string, dir: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  return norm(path).startsWith(norm(dir));
}

/** Repo or dist files whose bytes are a package image (sha256 sets): must be none. */
export function leakedImages(packageHashes: ReadonlySet<string>, files: ReadonlyArray<{ path: string; sha256: string }>): string[] {
  return files.filter((f) => packageHashes.has(f.sha256)).map((f) => f.path);
}

// ------------------------------------------------------------ scores

export interface TrackScore {
  track: HobTrack;
  metric: string;
  /** As the organisers report it: a fraction (0.0421 = 4.21%). */
  value: number;
}

export interface ScoreRecord {
  date: string;
  version: string;
  commit: string;
  submission: string;
  scores: TrackScore[];
}

/** A record can be published only with a date, a version and one score for each of the five tracks. */
export function validateScoreRecord(r: ScoreRecord): string[] {
  const errors: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) errors.push("date must be YYYY-MM-DD");
  if (!r.version) errors.push("version is required");
  if (!/^[0-9a-f]{7,40}$/.test(r.commit)) errors.push("commit must be a git sha");
  if (!r.submission) errors.push("submission id is required");
  for (const t of HOB_TRACKS) {
    const s = r.scores.filter((x) => x.track === t.id);
    if (s.length !== 1) errors.push(`${t.id}: ${s.length} scores, need exactly 1`);
    else if (!(s[0].value >= 0 && s[0].value <= 1)) errors.push(`${t.id}: value ${s[0].value} is not a fraction`);
  }
  for (const s of r.scores) if (!HOB_TRACKS.some((t) => t.id === s.track)) errors.push(`unknown track ${s.track}`);
  return errors;
}

/** More than this many percentage points between internal (7.5) and external CER opens a fix task. */
export const GAP_POINTS = 5;

export interface GapResult {
  track: HobTrack;
  internal: number;
  external: number;
  /** external - internal, in percentage points. */
  points: number;
  openFixTask: boolean;
}

/**
 * The gap rule. `internal` maps a track to our own CER on the matching split
 * (7.5's ocr-he: lines → lines, pages → pages, bidi → mixed); tracks without an
 * internal number are left out rather than compared with a guess.
 */
export function gaps(record: ScoreRecord, internal: Partial<Record<HobTrack, number>>): GapResult[] {
  const out: GapResult[] = [];
  for (const s of record.scores) {
    const i = internal[s.track];
    if (i === undefined) continue;
    const points = Math.round((s.value - i) * 10000) / 100;
    out.push({ track: s.track, internal: i, external: s.value, points, openFixTask: Math.abs(points) > GAP_POINTS });
  }
  return out;
}

// ------------------------------------------------------------ bidi regression (W5.4, W5.5)

const HEB_LETTER = /[א-ת]/;
const FINALS = "ךםןףץ";
const NON_FINALS = "כמנפצ";

/**
 * Signs that a Hebrew word came out reversed (W5.5's tell): a final form at
 * the start of a word, or a non-final form at its end, in a word of 2+ letters.
 */
export function reversedWords(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[א-ת]{2,}/g)) {
    const w = m[0];
    if (FINALS.includes(w[0]) || NON_FINALS.includes(w[w.length - 1])) out.push(w);
  }
  return out;
}

export interface BidiCheck {
  id: string;
  /** Direction marks left in the prediction (W5.4: OCR output must carry none). */
  marks: number;
  /** Words that look reversed (W5.5). */
  reversed: string[];
}

export function bidiCheck(id: string, prediction: string): BidiCheck {
  return { id, marks: (prediction.match(DIRECTION_MARKS) ?? []).length, reversed: reversedWords(prediction) };
}

/**
 * Between two runs of the bidi track (the last published one and this one):
 * items whose prediction changed, and items that newly fail a check. A change
 * is not wrong by itself (there is no gold here), but a new failure is.
 */
export function bidiRegressions(before: ReadonlyArray<PredictionRecord>, after: ReadonlyArray<PredictionRecord>): { changed: string[]; newFailures: BidiCheck[] } {
  const prev = new Map(before.filter((p) => p.track === "bidi").map((p) => [p.id, p.prediction]));
  const changed: string[] = [];
  const newFailures: BidiCheck[] = [];
  for (const p of after) {
    if (p.track !== "bidi") continue;
    const old = prev.get(p.id);
    if (old !== undefined && old !== p.prediction) changed.push(p.id);
    const now = bidiCheck(p.id, p.prediction);
    const was = old === undefined ? null : bidiCheck(p.id, old);
    const bad = now.marks > 0 || now.reversed.length > 0;
    const wasBad = was ? was.marks > 0 || was.reversed.length > 0 : false;
    if (bad && !wasBad) newFailures.push(now);
  }
  return { changed, newFailures };
}

export const hasHebrew = (s: string): boolean => HEB_LETTER.test(s);
