#!/usr/bin/env node
/**
 * Plan W4.17 — the mutation floor, enforced in every preview build without
 * running the mutants there (a full run takes hours; a preview build has
 * minutes).
 *
 * scripts/mutation/receipt.json records, for each critical module (the
 * `critical` list in targets.json), the score of its last mutation run and
 * the sha256 of the source it was measured on. This check fails when a
 * critical module on this branch:
 *   - has no entry in the receipt,
 *   - scores under `critical.min` (80),
 *   - or has changed since its run (the score no longer describes the code).
 * A changed test file is only reported: more tests do not lower a score,
 * and a weaker test file shows up at the next run.
 *
 * A module that is not on this branch is listed and skipped.
 *
 *   node scripts/mutation/check.mjs        (npm run mutation:check)
 *
 * After changing a critical module: `node scripts/mutation/run.mjs
 * --critical --module <name> --receipt`, then commit the receipt.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/**
 * The verdict for each critical module. `read(path)` returns a file's text or
 * null when it is not there.
 * @returns {{ module: string, state: "ok" | "absent" | "missing" | "low" | "stale", score?: number, note?: string, testsChanged?: boolean }[]}
 */
export function checkReceipt(targets, receipt, read) {
  const min = targets.critical?.min ?? 80;
  return (targets.critical?.modules ?? []).map((module) => {
    const src = read(module);
    if (src === null) return { module, state: "absent" };
    const r = receipt?.modules?.[module];
    if (!r) return { module, state: "missing", note: "no mutation run recorded" };
    const tests = targets.modules?.[module] ?? [];
    const testsHash = sha256(tests.map((t) => `${t.file}\0${t.filter ?? ""}\0${read(t.file) ?? ""}`).join("\0"));
    const testsChanged = r.tests !== testsHash;
    if (r.sha256 !== sha256(src)) return { module, state: "stale", score: r.score, note: `changed since its run on ${r.date}`, testsChanged };
    if (!(r.score >= min)) return { module, state: "low", score: r.score, note: `${r.score}% < ${min}%`, testsChanged };
    return { module, state: "ok", score: r.score, testsChanged };
  });
}

function main() {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const targets = JSON.parse(readFileSync(join(root, "scripts/mutation/targets.json"), "utf8"));
  const file = join(root, "scripts/mutation/receipt.json");
  const receipt = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null);
  const rows = checkReceipt(targets, receipt, read);
  const bad = rows.filter((r) => r.state === "missing" || r.state === "low" || r.state === "stale");
  for (const r of rows) {
    const mark = { ok: "✓", absent: "·", missing: "✗", low: "✗", stale: "✗" }[r.state];
    console.log(`${mark} ${r.module}: ${r.state === "absent" ? "not on this branch" : r.state === "ok" ? `${r.score}%` : r.note}${r.testsChanged && r.state !== "absent" ? " (its tests changed since the run)" : ""}`);
  }
  if (bad.length) {
    console.error(
      `\n✗ mutation: ${bad.length} critical module(s) without a current score of at least ${targets.critical?.min ?? 80}%. ` +
        `Run \`node scripts/mutation/run.mjs --critical --module <name> --receipt\`, add tests for the survivors it lists (reports/mutation/report.md), and commit scripts/mutation/receipt.json.`,
    );
    process.exit(1);
  }
  const measured = rows.filter((r) => r.state === "ok").length;
  console.log(`\n✓ mutation: ${measured} critical modules at or above ${targets.critical?.min ?? 80}% on their current source (${rows.length - measured} not on this branch).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
