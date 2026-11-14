#!/usr/bin/env node
/**
 * `npm run flags:check` (plan 14.4): the feature-flag registry is well
 * formed, every flag has its strings in English and Hebrew, and no flag
 * reached stable without an earlier beta.
 */
import { readFileSync } from "node:fs";
import { checkFlags } from "./lib/flags.mjs";
import { readLocale } from "./lib/i18n-files.mjs";

const registry = JSON.parse(readFileSync("src/flags/flags.json", "utf8"));
// Plan 0.3 split the strings into src/i18n/locales/<lang>/<domain>.json (W4.5 found this script still read he.json).
const keys = new Set(Object.keys(readLocale("en")));
const he = readLocale("he");
const problems = checkFlags(registry, { keys, he });
if (problems.length) {
  for (const p of problems) console.error(`✖ ${p}`);
  process.exit(1);
}
console.log(`✓ feature flags: ${registry.flags.length} flag(s), every one through beta before stable`);
