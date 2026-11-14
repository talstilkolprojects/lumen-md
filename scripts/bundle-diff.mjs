#!/usr/bin/env node
/**
 * Markdown table of bundle-size changes between two `bundle-budget.mjs
 * --json` outputs (base = main, head = this PR), for a PR comment / the CI
 * job summary. Classes that moved by less than 0.5 KB are folded into
 * "unchanged".
 *
 * Usage: node scripts/bundle-diff.mjs base.json head.json [baseLabel]
 */
import { readFileSync, existsSync } from "node:fs";

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export const MARKER = "<!-- lumen-bundle-diff -->";

/** The Markdown table for two `bundle-budget.mjs --json` records (base may be null). */
export function bundleDiffMarkdown(base, head, baseLabel = "main") {
  const kb = (x) => `${x.toFixed(1)} KB`;
  const delta = (d) => (d > 0 ? `+${d.toFixed(1)} KB` : `${d.toFixed(1)} KB`);
  const lines = [MARKER, "### Bundle size (gzipped)", ""];
  if (!base) {
    lines.push(`No size record for \`${baseLabel}\` yet; totals for this PR: **${kb(head.totalKb)}**.`);
    return lines.join("\n");
  }
  const names = [...new Set([...Object.keys(base.classes), ...Object.keys(head.classes)])];
  const rows = names
    .map((n) => {
      const b = base.classes[n]?.kb ?? 0;
      const h = head.classes[n]?.kb ?? 0;
      return { n, b, h, d: h - b };
    })
    .sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
  const moved = rows.filter((r) => Math.abs(r.d) >= 0.5);
  const totalDelta = head.totalKb - base.totalKb;
  const pct = base.totalKb ? (100 * totalDelta) / base.totalKb : 0;
  lines.push(`Total: **${kb(head.totalKb)}** (${delta(totalDelta)}, ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% vs \`${baseLabel}\`)`, "");
  if (moved.length) {
    lines.push("| Chunk class | " + baseLabel + " | this PR | change |", "|---|---:|---:|---:|");
    for (const r of moved) lines.push(`| ${r.n} | ${kb(r.b)} | ${kb(r.h)} | ${delta(r.d)} |`);
    lines.push("");
  }
  const same = rows.length - moved.length;
  if (same) lines.push(`${same} other chunk class${same === 1 ? "" : "es"} unchanged (< 0.5 KB).`);
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [basePath, headPath, baseLabel = "main"] = process.argv.slice(2);
  if (!headPath) {
    console.error("usage: bundle-diff.mjs base.json head.json [baseLabel]");
    process.exit(2);
  }
  const read = (p) => (p && existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
  const head = read(headPath);
  if (!head) {
    console.error(`no head sizes at ${headPath}`);
    process.exit(2);
  }
  console.log(bundleDiffMarkdown(read(basePath), head, baseLabel));
}
