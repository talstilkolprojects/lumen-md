#!/usr/bin/env node
/**
 * `npm run flags:check` (plan 14.4): the feature-flag registry is well
 * formed, every flag has its strings in English and Hebrew, and no flag
 * reached stable without an earlier beta.
 */
import { readFileSync } from "node:fs";
import { checkFlags } from "./lib/flags.mjs";

const registry = JSON.parse(readFileSync("src/flags/flags.json", "utf8"));
const en = readFileSync("src/i18n/index.ts", "utf8");
const keys = new Set([...en.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]));
const he = JSON.parse(readFileSync("src/i18n/locales/he.json", "utf8"));
const problems = checkFlags(registry, { keys, he });
if (problems.length) {
  for (const p of problems) console.error(`✖ ${p}`);
  process.exit(1);
}
console.log(`✓ feature flags: ${registry.flags.length} flag(s), every one through beta before stable`);
