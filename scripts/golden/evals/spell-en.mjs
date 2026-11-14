/**
 * Harness for the spell-en golden set (plan 6.10, English spelling on this
 * device; set built by 7.10).
 *
 * Runs the shipped code — englishSpelling() and the paragraph-language
 * routing englishOnly() from src/ai, loaded through tsx — with the same
 * nspell + dictionary-en files the worker bundles.
 *
 *   detection_recall     injected errors with a match on them (≥ 0.90)
 *   correction_at1       … whose first suggestion is the original word
 *   correction_at5       … with the original word among the suggestions
 *   fp_word_rate         flagged words / checked words in the clean
 *                        sentences (≤ 0.03)
 *   fp_sentence_rate     clean sentences with any flag (reported only)
 *
 * Numbers only; no item, input or output is ever reported.
 *
 *   node scripts/golden/evals/spell-en.mjs --dev   # dev split, exits 1 below target
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

export const TARGETS = { detection_recall: 0.9, fp_word_rate: 0.03 };

const require = createRequire(import.meta.url);
let loaded;
async function load() {
  if (loaded) return loaded;
  const nspell = require("nspell");
  // Node reads the package's own entry (node:fs); the app bundles the same two files.
  const { default: dict } = await import("dictionary-en");
  const text = (b) => new TextDecoder().decode(b);
  const spell = nspell(text(dict.aff), text(dict.dic));
  const lib = await tsImport("../../../src/ai/englishSpell.ts", import.meta.url);
  const svc = await tsImport("../../../src/ai/englishSpellService.ts", import.meta.url);
  loaded = { spell, ...lib, englishOnly: svc.englishOnly };
  return loaded;
}

const overlaps = (m, e) => m.offset < e.end && e.start < m.offset + m.length;

export async function score({ items }) {
  const { spell, englishSpelling, spellWords, englishOnly } = await load();
  const suggestCache = new Map();
  const check = async (text) => englishSpelling(spell, await englishOnly(text), { suggestCache, maxSuggest: Infinity });
  let edits = 0, found = 0, at1 = 0, at5 = 0, words = 0, flagged = 0, sentences = 0, dirty = 0;
  for (const it of items) {
    const noisy = String(it.noisy ?? "");
    const clean = String(it.clean ?? "");
    const matches = await check(noisy);
    for (const e of it.edits ?? []) {
      edits++;
      const m = matches.find((x) => overlaps(x, e));
      if (!m) continue;
      found++;
      if (m.replacements[0] === e.right) at1++;
      if (m.replacements.slice(0, 5).includes(e.right)) at5++;
    }
    const fp = await check(clean);
    words += spellWords(clean).length;
    flagged += fp.length;
    sentences++;
    if (fp.length) dirty++;
  }
  const rate = (a, n) => (n ? a / n : NaN);
  return {
    detection_recall: rate(found, edits),
    correction_at1: rate(at1, edits),
    correction_at5: rate(at5, edits),
    fp_word_rate: rate(flagged, words),
    fp_sentence_rate: rate(dirty, sentences),
  };
}

export function meetsTargets(s) {
  return s.detection_recall >= TARGETS.detection_recall && s.fp_word_rate <= TARGETS.fp_word_rate;
}

/** The committed dev split, as the vitest gate and the CLI read it. */
export function devItems() {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const set = JSON.parse(readFileSync(join(root, "eval/golden/spell-en/dev/moby.json"), "utf8"));
  return set.items;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href && process.argv.includes("--dev")) {
  const s = await score({ items: devItems() });
  console.log(JSON.stringify({ split: "dev", items: devItems().length, ...s, targets: TARGETS, pass: meetsTargets(s) }, null, 2));
  process.exit(meetsTargets(s) ? 0 : 1);
}
