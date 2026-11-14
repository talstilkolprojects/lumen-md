#!/usr/bin/env node
/**
 * Launch materials (plan W2.25): the honest comparison and the beta page.
 *
 *   node scripts/launch-check.mjs            check launch/comparison.json, and that the docs pages match it
 *   node scripts/launch-check.mjs --write    (re)write docs project/compare (en, he) from the JSON
 *   node scripts/launch-check.mjs --strict   also fail while any claim is unverified (run before launch)
 *
 * Every claim needs a source. Lumen's own claims cite its docs pages, which
 * must exist. The comparison page marks claims still waiting for a fact check.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { compareProblems, renderCompare } from "./lib/launch.mjs";

const data = JSON.parse(readFileSync("launch/comparison.json", "utf8"));
const docExists = (slug) => ["md", "mdx"].some((x) => existsSync(`docs/src/content/docs/${slug.replace(/^\/|\/$/g, "")}.${x}`));
const strict = process.argv.includes("--strict");
const problems = compareProblems(data, { docExists, strict });
const pages = { en: "docs/src/content/docs/project/compare.md", he: "docs/src/content/docs/he/project/compare.md" };
if (process.argv.includes("--write")) {
  for (const [lang, p] of Object.entries(pages)) writeFileSync(p, renderCompare(data, lang));
  console.error("wrote", Object.values(pages).join(", "));
} else {
  for (const [lang, p] of Object.entries(pages)) {
    if (!existsSync(p) || readFileSync(p, "utf8") !== renderCompare(data, lang)) problems.push(`${p} is out of date: run node scripts/launch-check.mjs --write`);
  }
}
const unverified = data.claims.filter((c) => !c.verified).length;
if (problems.length) {
  for (const p of problems) console.error(`✖ ${p}`);
  process.exit(1);
}
console.log(`✓ comparison: ${data.claims.length} claims, every one with a source; ${unverified} still to verify${strict ? "" : " (--strict fails on these)"}`);
