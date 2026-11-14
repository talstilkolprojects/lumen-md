#!/usr/bin/env node
/**
 * Recall and precision of the Hebrew grammar checker on a HUMAN-LABELLED set
 * (plan W10.B8, audit W5.3). eval/probes/hebrew-grammar.json cannot give
 * these: it is generated from the rules' own patterns (rule coverage).
 *
 *   node scripts/grammar/eval.mjs                    # eval/golden/grammar-human/set.json
 *   node scripts/grammar/eval.mjs --set <file.json>  # any set in this format
 *   node scripts/grammar/eval.mjs --json             # machine-readable
 *
 * Until a set exists it says so and measures nothing (exit 3: not measured).
 * The set comes from contributors (plan 10.O). Its format:
 *
 *   {
 *     "origin": "real",                      // required: real sentences, not generated
 *     "labelledBy": "human",                 // required
 *     "source": "where the sentences come from and who labelled them",
 *     "license": "CC-BY-4.0",
 *     "items": [
 *       { "id": "h-001", "text": "…", "hasError": true,
 *         "spans": [{ "offset": 12, "length": 5 }] },   // optional: where the error is
 *       { "id": "h-002", "text": "…", "hasError": false }
 *     ]
 *   }
 *
 * `flawed` is accepted for `hasError` (the held-out sets' field,
 * scripts/heldout/sets.mjs). Sentence level: the checker "says error" when
 * it reports any finding. Span level (items with spans): a span is found
 * when a finding overlaps it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const DEFAULT_SET = "eval/golden/grammar-human/set.json";

const round = (x) => Math.round(x * 1000) / 1000;

/** Problems that make a set unusable for recall (empty = usable). */
export function validateSet(set) {
  const problems = [];
  if (!set || typeof set !== "object") return ["not an object"];
  if (set.origin !== "real") problems.push(`origin must be "real" (got ${JSON.stringify(set.origin)}): a generated set measures rule coverage, not recall`);
  if (set.labelledBy !== "human") problems.push(`labelledBy must be "human" (got ${JSON.stringify(set.labelledBy)})`);
  if (!Array.isArray(set.items) || set.items.length === 0) problems.push("items must be a non-empty list");
  else
    set.items.forEach((it, i) => {
      const gold = it?.hasError ?? it?.flawed;
      if (typeof it?.text !== "string" || !it.text.trim()) problems.push(`items[${i}]: text is missing`);
      if (typeof gold !== "boolean") problems.push(`items[${i}]: hasError must be true or false`);
    });
  return problems;
}

/**
 * Score `check(text) → [{ offset, length }]` on a labelled set.
 * @returns {{ n, tp, fp, fn, tn, precision, recall, f1, spans: { n, found, recall } | null }}
 */
export function scoreLabelled(check, set) {
  let tp = 0, fp = 0, fn = 0, tn = 0, spanN = 0, spanFound = 0;
  for (const it of set.items) {
    const gold = it.hasError ?? it.flawed;
    const found = check(it.text);
    const pred = found.length > 0;
    if (pred && gold) tp++;
    else if (pred && !gold) fp++;
    else if (!pred && gold) fn++;
    else tn++;
    for (const s of it.spans ?? []) {
      spanN++;
      if (found.some((m) => m.offset < s.offset + s.length && s.offset < m.offset + m.length)) spanFound++;
    }
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  return {
    n: set.items.length, tp, fp, fn, tn,
    precision: round(precision), recall: round(recall),
    f1: round(precision + recall ? (2 * precision * recall) / (precision + recall) : 0),
    spans: spanN ? { n: spanN, found: spanFound, recall: round(spanFound / spanN) } : null,
  };
}

async function main(argv) {
  const at = argv.indexOf("--set");
  const rel = at >= 0 ? argv[at + 1] : DEFAULT_SET;
  const file = resolve(ROOT, rel);
  const json = argv.includes("--json");
  if (!existsSync(file)) {
    const msg = `no human-labelled grammar set at ${rel}: recall and precision are NOT measured (plan 10.O collects one). The rule-coverage probe (eval/probes/hebrew-grammar.json) is not a substitute.`;
    console.log(json ? JSON.stringify({ status: "not-measured", reason: msg }) : msg);
    return 3;
  }
  const set = JSON.parse(readFileSync(file, "utf8"));
  const problems = validateSet(set);
  if (problems.length) {
    console.error(`${rel} cannot measure recall:\n  - ${problems.join("\n  - ")}`);
    return 1;
  }
  const { tsImport } = await import("tsx/esm/api");
  const { hebrewGrammar } = await tsImport(join(ROOT, "src/ai/hebrewGrammar.ts"), import.meta.url);
  const r = scoreLabelled((t) => hebrewGrammar(t), set);
  if (json) console.log(JSON.stringify({ status: "measured", set: rel, ...r }));
  else {
    console.log(`Hebrew grammar checker on ${rel} (${r.n} human-labelled sentences)`);
    console.log(`  precision ${r.precision}  recall ${r.recall}  F1 ${r.f1}  (tp ${r.tp}, fp ${r.fp}, fn ${r.fn}, tn ${r.tn})`);
    if (r.spans) console.log(`  error spans found: ${r.spans.found}/${r.spans.n} (${r.spans.recall})`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then((c) => process.exit(c));
