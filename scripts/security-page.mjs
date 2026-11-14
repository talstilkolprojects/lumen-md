#!/usr/bin/env node
/**
 * The public security page (plan W11.S12): /security and /he/security,
 * written from security/findings.json and the plugin scorecards.
 *
 *   node scripts/security-page.mjs           write docs/src/content/docs/{,he/}security/index.md
 *   node scripts/security-page.mjs --check   exit 1 when the register is invalid or a page is out of date
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findingsProblems, renderSecurityPage } from "./lib/securityPage.mjs";

const root = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : ".";
const findings = JSON.parse(readFileSync(join(root, "security/findings.json"), "utf8"));
const dir = join(root, "public/plugins/examples/scorecards");
const cards = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")).sort().map((n) => JSON.parse(readFileSync(join(dir, n), "utf8"))) : [];
const problems = findingsProblems(findings);
const pages = { en: join(root, "docs/src/content/docs/security/index.md"), he: join(root, "docs/src/content/docs/he/security/index.md") };
if (process.argv.includes("--check")) {
  for (const [lang, p] of Object.entries(pages)) if (!existsSync(p) || readFileSync(p, "utf8") !== renderSecurityPage(findings, cards, lang)) problems.push(`${p} is out of date: run node scripts/security-page.mjs`);
  for (const p of problems) console.error(`✖ ${p}`);
  if (problems.length) process.exit(1);
  console.log(`✓ security page: ${findings.findings.filter((f) => f.status !== "fixed").length} open findings, ${cards.length} plugin scorecards, both languages current`);
} else {
  if (problems.length) {
    for (const p of problems) console.error(`✖ ${p}`);
    process.exit(1);
  }
  for (const [lang, p] of Object.entries(pages)) writeFileSync(p, renderSecurityPage(findings, cards, lang));
  console.log(`wrote ${Object.values(pages).join(", ")}`);
}
