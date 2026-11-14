/**
 * Harness for the langid golden set (plan 6.5, local language detection).
 *
 * Scores the app's own detector — detectLanguage() in src/text/langId.ts,
 * loaded through tsx so the harness runs the shipped code, not a copy —
 * against each item's expected BCP-47 primary tag ("und" = no language).
 *
 *   tatoeba_accuracy  CC0 Tatoeba sentences in the 8 UI languages — the
 *                     acceptance metric (≥ 0.95)
 *   hard_accuracy     the hard cases (short, mixed, look-alike languages)
 *   hard_lumen8_accuracy  the hard cases in the 8 UI languages only
 *
 * Accuracies only; no item, input or output is ever reported.
 */
import { tsImport } from "tsx/esm/api";

let detector;
async function load() {
  detector ??= await tsImport("../../../src/text/langId.ts", import.meta.url);
  return detector;
}

const rate = ([a, n]) => (n ? a / n : NaN);

export async function score({ items }) {
  const { detectLanguage } = await load();
  const tally = { tatoeba: [0, 0], hard: [0, 0], hard8: [0, 0] };
  for (const it of items) {
    const got = detectLanguage(String(it.text ?? "")).lang;
    const ok = got === it.lang ? 1 : 0;
    const part = it.part === "tatoeba" || String(it.id ?? "").startsWith("tatoeba") ? "tatoeba" : "hard";
    tally[part][0] += ok;
    tally[part][1] += 1;
    if (part === "hard" && it.scope === "lumen-8") {
      tally.hard8[0] += ok;
      tally.hard8[1] += 1;
    }
  }
  return { tatoeba_accuracy: rate(tally.tatoeba), hard_accuracy: rate(tally.hard), hard_lumen8_accuracy: rate(tally.hard8) };
}

/** For a local look at which dev items fail (never used by run-evals, which only reads score()). */
export async function explain(items) {
  const { detectLanguage } = await load();
  return items.map((it) => ({ id: it.id, want: it.lang, got: detectLanguage(String(it.text ?? "")).lang }));
}
