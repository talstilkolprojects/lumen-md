#!/usr/bin/env node
/**
 * npm run import:diff (plan W11.P2): one export, imported by lumen-md and by
 * Obsidian Importer, compared metric by metric (scripts/lib/importDiff.mjs).
 *
 *   npm run import:diff -- --lumen <folder> --oracle <folder> [--explain explain.json] [--json] [--out report.md]
 *
 *   --lumen    the folder lumen-md's import wrote (Imported/<name>, or that folder of an exported vault)
 *   --oracle   the folder Obsidian Importer wrote for the same export, with its default settings
 *   --explain  {"<metric>": "why lumen-md has less here"}; covers a shortfall of ≤ 1% only
 *
 * Exit 1 when the gate fails. Reads the two folders only; sends nothing.
 * Hidden folders (.obsidian, .trash) are not part of either vault.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { compareVaults, diffMarkdown, readVault } from "./lib/importDiff.mjs";

const args = process.argv.slice(2);
const opt = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const lumen = opt("--lumen");
const oracle = opt("--oracle");
if (!lumen || !oracle) {
  console.error("usage: npm run import:diff -- --lumen <folder> --oracle <folder> [--explain explain.json] [--json] [--out report.md]");
  process.exit(2);
}
const explain = opt("--explain") ? JSON.parse(readFileSync(opt("--explain"), "utf8")) : {};
const r = compareVaults(readVault(lumen), readVault(oracle), explain);
const out = args.includes("--json") ? JSON.stringify(r, null, 2) + "\n" : diffMarkdown(r);
if (opt("--out")) writeFileSync(opt("--out"), out);
process.stdout.write(out);
process.exit(r.pass ? 0 : 1);
