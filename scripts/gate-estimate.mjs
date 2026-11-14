#!/usr/bin/env node
/**
 * W6.8: does the preview gate fit its 38 minutes? A calculation from a
 * measured build, not a guess.
 *
 * scripts/vercel-build.mjs writes a receipt of every gate it ran and how
 * long each took (reports/vercel-build.json, served as /__build/receipt.json
 * on a preview). This adds up the gates of PREVIEW_GATES from such a receipt
 * and compares the sum with GATE_BUDGET_MIN (scripts/test-tiers.mjs). A gate
 * that PREVIEW_GATES has but the receipt does not (a gate added since that
 * build, or a build that stopped early) is not counted as zero: the verdict
 * is then "unknown", which never passes.
 *
 *   node scripts/gate-estimate.mjs [receipt.json]   (default reports/vercel-build.json)
 *
 * Exit 0 inside the budget, 1 over it, 2 unknown (no receipt, or a gate unmeasured).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GATE_BUDGET_MIN } from "./test-tiers.mjs";
import { PREVIEW_GATES } from "./vercel-build.mjs";

/**
 * The verdict on a receipt: { status: "ok" | "over" | "unknown", minutes, missing, lines }.
 * `minutes` is the sum of the measured preview gates; the build's own total
 * (receipt.totalMinutes) wins when it is larger, since it also holds the time between gates.
 */
export function estimateGate(receipt, { gates = PREVIEW_GATES, budgetMin = GATE_BUDGET_MIN } = {}) {
  if (!receipt || !Array.isArray(receipt.gates)) {
    return { status: "unknown", minutes: null, missing: [...gates], lines: ["no receipt with gate times: nothing to calculate from (not a pass)"] };
  }
  const seconds = new Map();
  for (const g of receipt.gates) {
    if (g && typeof g.gate === "string" && Number.isFinite(g.seconds) && g.seconds >= 0) seconds.set(g.gate, (seconds.get(g.gate) ?? 0) + g.seconds);
  }
  const missing = gates.filter((g) => !seconds.has(g));
  const sumSec = gates.reduce((s, g) => s + (seconds.get(g) ?? 0), 0);
  const total = Number.isFinite(receipt.totalMinutes) ? receipt.totalMinutes : 0;
  const minutes = Math.round(Math.max(sumSec / 60, total) * 10) / 10;
  const lines = gates.map((g) => (seconds.has(g) ? `${String((seconds.get(g) / 60).toFixed(1)).padStart(6)} min  ${g}` : `     ?      ${g} (not in the receipt)`));
  if (missing.length) {
    lines.push(`unknown: ${missing.length} preview gate(s) unmeasured (${missing.join(", ")}); the ${minutes} min measured is a lower bound, not a pass`);
    return { status: "unknown", minutes, missing, lines };
  }
  const over = minutes > budgetMin;
  lines.push(`${over ? "over" : "inside"} the budget: ${minutes} min against ${budgetMin} (Vercel stops at 45)`);
  return { status: over ? "over" : "ok", minutes, missing, lines };
}

function main() {
  const file = process.argv[2] ?? "reports/vercel-build.json";
  let receipt = null;
  try {
    receipt = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`gate-estimate: could not read ${file}: ${e instanceof Error ? e.message : e}`);
  }
  const v = estimateGate(receipt);
  (v.status === "ok" ? console.log : console.error)(`gate-estimate (${file}):\n${v.lines.join("\n")}`);
  process.exit(v.status === "ok" ? 0 : v.status === "over" ? 1 : 2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
