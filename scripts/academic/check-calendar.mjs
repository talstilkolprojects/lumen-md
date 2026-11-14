#!/usr/bin/env node
/**
 * Plan W7.8: compare an academic calendar file with a golden table typed
 * from the institution's official document, field by field.
 *
 *   node scripts/academic/check-calendar.mjs data/academic/haifa/5787.json golden.json
 *
 * The golden file has the same shape (semesters, exams, breaks, makeupDays).
 * Prints every mismatch and the share of fields that match; exits 1 below 100%.
 */
import { readFileSync } from "node:fs";

const [file, golden] = process.argv.slice(2);
if (!file || !golden) {
  console.error("usage: check-calendar.mjs <data file> <golden file>");
  process.exit(2);
}
const a = JSON.parse(readFileSync(file, "utf8"));
const g = JSON.parse(readFileSync(golden, "utf8"));
const fields = (c) => {
  const out = new Map();
  for (const s of c.semesters ?? []) (out.set(`semester ${s.id} start`, s.start), out.set(`semester ${s.id} end`, s.end));
  for (const e of c.exams ?? []) (out.set(`exams ${e.semester}/${e.moed} start`, e.start), out.set(`exams ${e.semester}/${e.moed} end`, e.end));
  for (const b of c.breaks ?? []) (out.set(`break ${b.name} start`, b.start), out.set(`break ${b.name} end`, b.end));
  for (const d of c.makeupDays ?? []) out.set(`makeup ${d}`, d);
  return out;
};
const want = fields(g);
const have = fields(a);
let ok = 0;
for (const [k, v] of want) {
  if (have.get(k) === v) ok++;
  else console.log(`MISMATCH ${k}: file ${have.get(k) ?? "missing"}, document ${v}`);
}
for (const k of have.keys()) if (!want.has(k)) console.log(`EXTRA ${k}: not in the document`);
const pct = want.size ? (100 * ok) / want.size : 0;
console.log(`${ok}/${want.size} fields match (${pct.toFixed(1)}%)`);
process.exit(pct === 100 && have.size === want.size ? 0 : 1);
