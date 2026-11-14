#!/usr/bin/env node
/**
 * Plan W2.7 acceptance — DER on the golden Hebrew meeting recordings.
 *
 *   node scripts/meetings/der.mjs --golden <dir> [--collar 0] [--max 0.20] [--min-recordings 5] [--out der-scores.json]
 *
 * <dir> holds, per recording <name>:
 *   <name>.rttm   the reference (hand-checked speaker turns, RTTM)
 *   <name>.md     the meeting note the app wrote for <name>'s audio
 *                 ("Transcribe a meeting recording…"; its lumen-speaker-turns
 *                 block is the hypothesis), or <name>.hyp.rttm instead
 *
 * Prints each recording's DER and the pooled DER (no transcript text) and
 * exits 1 when the pooled DER is over --max or fewer than --min-recordings
 * recordings were scored. The recordings stay with the owner; nothing is
 * uploaded.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { der, parseRttm, pooledDer, turnsFromNote } from "../lib/der.mjs";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const dir = flag("--golden");
if (!dir || !existsSync(dir)) {
  console.error("usage: node scripts/meetings/der.mjs --golden <dir> [--collar 0] [--max 0.20] [--min-recordings 5] [--out der-scores.json]");
  process.exit(2);
}
const collar = Number(flag("--collar", "0"));
const max = Number(flag("--max", "0.20"));
const minRec = Number(flag("--min-recordings", "5"));

const results = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith(".rttm") && !x.endsWith(".hyp.rttm")).sort()) {
  const name = f.slice(0, -5);
  const ref = parseRttm(readFileSync(join(dir, f), "utf8"));
  let hyp = null;
  if (existsSync(join(dir, `${name}.md`))) hyp = turnsFromNote(readFileSync(join(dir, `${name}.md`), "utf8"));
  else if (existsSync(join(dir, `${name}.hyp.rttm`))) hyp = parseRttm(readFileSync(join(dir, `${name}.hyp.rttm`), "utf8"));
  if (!hyp) {
    console.log(`${name}: no hypothesis (${name}.md with a lumen-speaker-turns block, or ${name}.hyp.rttm) — not scored`);
    continue;
  }
  const r = der(ref, hyp, { collar });
  results.push({ name, ...r, refSpeakers: new Set(ref.map((x) => x.speaker)).size, hypSpeakers: new Set(hyp.map((x) => x.speaker)).size });
  console.log(`${name}: DER ${(r.der * 100).toFixed(1)}%  (missed ${r.missed.toFixed(1)} s, false alarm ${r.falseAlarm.toFixed(1)} s, confusion ${r.confusion.toFixed(1)} s of ${r.total.toFixed(1)} s; speakers ${results.at(-1).hypSpeakers}/${results.at(-1).refSpeakers})`);
}
const pooled = pooledDer(results);
console.log(`pooled DER ${(pooled * 100).toFixed(1)}% over ${results.length} recordings (collar ${collar} s; target ≤ ${(max * 100).toFixed(0)}%)`);
const out = flag("--out");
if (out) writeFileSync(out, JSON.stringify({ collar, pooled, results }, null, 2) + "\n");
if (results.length < minRec) {
  console.error(`only ${results.length} recordings scored; the plan needs ${minRec}`);
  process.exit(1);
}
process.exit(pooled <= max ? 0 : 1);
