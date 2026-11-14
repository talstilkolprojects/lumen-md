/**
 * Handwriting OCR on ivrit-ai/hebrew-handwriting-ocr-benchmark (plan
 * W11.H14): 225 gold lines by 10 writers, held out (never trained on), under
 * the ivrit.ai licence. The card's metrics are word coverage (the headline),
 * median CER over lines and micro CER over all characters.
 *
 * Word coverage here: per line, the reference words the prediction contains
 * (as a multiset: a word written twice must be read twice), summed over
 * lines and divided by all reference words. The leaderboard's exact
 * definition could not be read offline; the parity check against its
 * published scores is owed with the first real run.
 *
 * Format "image-jsonl": what scripts/eval-public/export_hf_images.py writes
 * from the Hub's Parquet — { "id", "writer", "image" (path), "text" }.
 * Text is compared in logical order, never mirrored, after NFC and
 * whitespace collapsing only (no punctuation stripping: the benchmark
 * scores punctuation).
 */
import { countChars, itemCer, median, microRate, r4, words } from "../metrics";

export interface HandwritingItem {
  id: string;
  writer: string;
  image: string;
  text: string;
}
export interface OcrEngine {
  id: string;
  recognize(image: string): Promise<string>;
}

export function parseImageJsonl(text: string): HandwritingItem[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l, i) => {
      const o = JSON.parse(l) as Partial<HandwritingItem> & { writer?: unknown };
      if (typeof o.id !== "string" || typeof o.image !== "string" || typeof o.text !== "string") throw new Error(`image-jsonl line ${i + 1}: id, image and text are required strings`);
      return { id: o.id, writer: String(o.writer ?? ""), image: o.image, text: o.text };
    });
}

export const normalizeLine = (s: string): string => s.normalize("NFC").replace(/\s+/g, " ").trim();

export function wordCoverage(ref: string, hyp: string): { hit: number; total: number } {
  const want = words(ref);
  const have = new Map<string, number>();
  for (const w of words(hyp)) have.set(w, (have.get(w) ?? 0) + 1);
  let hit = 0;
  for (const w of want) {
    const k = have.get(w) ?? 0;
    if (k > 0) {
      hit++;
      have.set(w, k - 1);
    }
  }
  return { hit, total: want.length };
}

export interface HandwritingScore {
  n: number;
  writers: number;
  metrics: { wordCoverage: number; medianCer: number; microCer: number };
}

export async function scoreHandwriting(items: readonly HandwritingItem[], engine: OcrEngine): Promise<HandwritingScore> {
  let hit = 0;
  let total = 0;
  const per: number[] = [];
  const counts = [];
  for (const it of items) {
    const p = { ref: normalizeLine(it.text), hyp: normalizeLine(await engine.recognize(it.image)) };
    const c = wordCoverage(p.ref, p.hyp);
    hit += c.hit;
    total += c.total;
    per.push(itemCer(p));
    counts.push(countChars(p));
  }
  return {
    n: items.length,
    writers: new Set(items.map((i) => i.writer)).size,
    metrics: { wordCoverage: r4(total ? hit / total : Number.NaN), medianCer: r4(median(per)), microCer: r4(microRate(counts)) },
  };
}

/** W11.H14: handwriting recognition is offered only at median CER ≤ 20 % on the public benchmark. */
export const HANDWRITING_MEDIAN_CER_MAX = 0.2;
export function handwritingExposed(m: { medianCer: number } | null | undefined): boolean {
  return !!m && Number.isFinite(m.medianCer) && m.medianCer <= HANDWRITING_MEDIAN_CER_MAX;
}
