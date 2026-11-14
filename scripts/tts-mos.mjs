#!/usr/bin/env node
/**
 * Read-aloud listening test (plan W2.6), owner side.
 *
 *   npm run tts:mos -- sheet --raters r1,r2,r3,r4,r5 [--out tts-ratings.csv] [--note tts-listening.md]
 *        a blank score sheet, and a note with the 20 numbered sentences to
 *        open in Lumen and play with Read aloud (one sentence at a time)
 *   npm run tts:mos -- score tts-ratings.csv [--out eval/results/tts-mos.json]
 *        MOS with its 95% interval, per sentence and per rater; exit 1 below 3.8
 *
 * Raters score each sentence 1 (bad) – 5 (excellent) for naturalness and
 * correct pronunciation. The voice (system or neural) is written down with
 * the results by whoever runs the test.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mos, parseRatings, sheet, validateRatings } from "./lib/tts-mos.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const golden = JSON.parse(readFileSync(new URL("../eval/listening/tts-he.json", import.meta.url), "utf8"));
const ids = golden.sentences.map((s) => s.id);

if (cmd === "sheet") {
  const raters = (flag("--raters") ?? "r1,r2,r3,r4,r5").split(",").map((x) => x.trim()).filter(Boolean);
  const out = flag("--out") ?? "tts-ratings.csv";
  const note = flag("--note") ?? "tts-listening.md";
  writeFileSync(out, sheet(ids, raters));
  writeFileSync(note, `# Listening test (W2.6)\n\nRead aloud one sentence at a time; score each 1–5 in ${out}.\n\n${golden.sentences.map((s) => `${s.id}. ${s.text}`).join("\n\n")}\n`);
  console.log(`written: ${out} (${raters.length} raters × ${ids.length} sentences), ${note}`);
  process.exit(0);
}

if (cmd === "score") {
  const file = args[1];
  if (!file) {
    console.error("usage: npm run tts:mos -- score <ratings.csv> [--out file]");
    process.exit(1);
  }
  const rows = parseRatings(readFileSync(file, "utf8"));
  const problems = validateRatings(rows, ids);
  if (problems.length) {
    console.error(`✗ ${problems.slice(0, 20).join("\n✗ ")}`);
    process.exit(1);
  }
  const r = mos(rows);
  const out = flag("--out") ?? "eval/results/tts-mos.json";
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ date: new Date().toISOString().slice(0, 10), ...r }, null, 2) + "\n");
  console.log(`MOS ${r.mos} (95% ${r.ci95[0]}–${r.ci95[1]}), ${r.raters} raters × ${ids.length} sentences — ${r.pass ? "✓" : "✗"} target ${r.target}\nwritten: ${out}`);
  process.exit(r.pass ? 0 : 1);
}

console.error("usage: npm run tts:mos -- sheet [--raters a,b,c,d,e] | score <ratings.csv>");
process.exit(1);
