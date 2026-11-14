/**
 * Hebrew pronunciation (G2P) on MILIM (plan W11.H10): 1,653 sentences,
 * 3,110 target words in 11 categories (ReNikud, arXiv 2606.20179). The
 * paper scores the target words' phoneme strings: WER over target words
 * (a word is wrong unless its whole phoneme string is right) and CER over
 * their phonemes.
 *
 * Format "milim-jsonl", inferred from the paper's description because the
 * release could not be read here: one JSON object per line,
 * { "id", "category", "sentence", "targets": [{ "index" (word index in the
 * sentence), "word", "ipa" }] }. The loader checks every field and fails
 * loudly, so a different release format stops the run instead of scoring
 * garbage; re-check it against the release when it is downloaded (owed).
 */
import { editDistance, r4 } from "../metrics";

export interface MilimTarget {
  index: number;
  word: string;
  ipa: string;
}
export interface MilimItem {
  id: string;
  category: string;
  sentence: string;
  targets: MilimTarget[];
}

export interface G2pEngine {
  id: string;
  /** Phonemes (IPA) for each space-separated word of the sentence, in order. */
  phonemize(sentence: string): Promise<string[]>;
}

export function parseMilimJsonl(text: string): MilimItem[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l, i) => {
      const o = JSON.parse(l) as Partial<MilimItem>;
      const bad = (what: string) => new Error(`milim-jsonl line ${i + 1}: ${what}`);
      if (typeof o.id !== "string" || typeof o.category !== "string" || typeof o.sentence !== "string") throw bad("id, category and sentence are required strings");
      if (!Array.isArray(o.targets) || !o.targets.length) throw bad("targets must be a non-empty array");
      const n = o.sentence.split(/\s+/).filter(Boolean).length;
      for (const t of o.targets) if (!Number.isInteger(t.index) || t.index < 0 || t.index >= n || typeof t.ipa !== "string" || typeof t.word !== "string") throw bad("every target needs index (in the sentence), word and ipa");
      return o as MilimItem;
    });
}

const norm = (ipa: string) => ipa.normalize("NFC").replace(/[ˈˌ.\s]/g, "");

export interface G2pScore {
  n: number;
  targets: number;
  metrics: { wer: number; cer: number };
  byCategory: Record<string, { targets: number; wer: number }>;
}

/** Stress marks and syllable dots are ignored (`withStress: true` keeps stress). */
export async function scoreG2p(items: readonly MilimItem[], engine: G2pEngine, opts: { withStress?: boolean } = {}): Promise<G2pScore> {
  const n = opts.withStress ? (s: string) => s.normalize("NFC").replace(/[.\s]/g, "") : norm;
  let wrong = 0;
  let targets = 0;
  let edits = 0;
  let phones = 0;
  const cat: Record<string, { targets: number; wrong: number }> = {};
  for (const it of items) {
    const out = await engine.phonemize(it.sentence);
    for (const t of it.targets) {
      const ref = Array.from(n(t.ipa));
      const hyp = Array.from(n(out[t.index] ?? ""));
      const d = editDistance(ref, hyp);
      targets++;
      phones += ref.length;
      edits += d;
      const c = (cat[it.category] ??= { targets: 0, wrong: 0 });
      c.targets++;
      if (d) {
        wrong++;
        c.wrong++;
      }
    }
  }
  return {
    n: items.length,
    targets,
    metrics: { wer: r4(targets ? wrong / targets : Number.NaN), cer: r4(phones ? edits / phones : Number.NaN) },
    byCategory: Object.fromEntries(Object.entries(cat).map(([k, v]) => [k, { targets: v.targets, wer: r4(v.wrong / v.targets) }])),
  };
}

/** W11.H10: ReNikud may voice the read-aloud only with a permissive licence and MILIM WER ≤ 0.8 × Phonikud's. */
export function renikudAllowed(o: { licenseAllowed: boolean; renikudWer: number | null; phonikudWer: number | null }): boolean {
  if (!o.licenseAllowed || o.renikudWer === null || o.phonikudWer === null) return false;
  if (!Number.isFinite(o.renikudWer) || !Number.isFinite(o.phonikudWer)) return false;
  return o.renikudWer <= 0.8 * o.phonikudWer + 1e-12;
}
