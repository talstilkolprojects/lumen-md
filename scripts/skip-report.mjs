#!/usr/bin/env node
/**
 * The skipped-test report (plan W4.12): every skip in src/ and e2e/ with its
 * reason, task and review date, and which user flows run only in part of the
 * test matrix because of one.
 *
 *   engine     the flow runs on the other engines (e.g. not on WebKit)
 *   setup      the flow runs only in a special setup: the production build,
 *              the dev server, a model or service on the machine, an opt-in
 *              measurement. The default `npx playwright test` / `npx vitest
 *              run` does not check it.
 *   deferred   a `todo`: written down, checks nothing yet
 *
 * Tests that go through e2e/_opfs.ts `vaultOrSkip` are listed by title: they
 * skip on the engines in OPFS_GAP and fail elsewhere when the vault cannot
 * be written.
 *
 * Usage: node scripts/skip-report.mjs [--json]   (npm run skips)
 * Exit 1 when the audit has violations (the same check as npm run hygiene).
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { auditSkips, MAX_E2E_SKIPS, parseAnnotation, testSourceFiles } from "./lib/skipAudit.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** engine | setup | deferred, from the call and its condition. */
export function classify(site) {
  if (/\.todo$/.test(site.call)) return "deferred";
  if (/browserName|OPFS_GAP/.test(site.condition)) return "engine";
  return "setup";
}

/** Titles of the e2e tests that call vaultOrSkip, as { file, title }. */
export function vaultGatedTests(dir = join(root, "e2e")) {
  const out = [];
  for (const file of testSourceFiles(dir)) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("vaultOrSkip(") || file.endsWith("_opfs.ts")) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const rel = relative(root, file).split("\\").join("/");
    const titleOf = (call) => {
      const a = call.arguments[0];
      return a && (ts.isStringLiteralLike(a) || ts.isNoSubstitutionTemplateLiteral(a)) ? a.text : a ? a.getText(sf) : "?";
    };
    const visit = (node, title) => {
      let t = title;
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(sf);
        if (callee === "test" || callee === "test.only") t = titleOf(node);
        else if (callee === "test.beforeEach") t = "(every test in the file)";
        else if (callee === "vaultOrSkip" && title) out.push({ file: rel, title });
      }
      ts.forEachChild(node, (c) => visit(c, t));
    };
    visit(sf, "");
  }
  const seen = new Set();
  return out.filter((x) => (seen.has(`${x.file}\0${x.title}`) ? false : seen.add(`${x.file}\0${x.title}`)));
}

function main() {
  const { sites, violations, e2eCount } = auditSkips(root);
  const rows = sites.map((s) => ({ ...s, kind: classify(s), ...(s.annotation ? parseAnnotation(s.annotation) : { why: "", task: "", until: "" }) }));
  const gated = vaultGatedTests();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ e2eCount, max: MAX_E2E_SKIPS, sites: rows.map(({ problems: _p, ...r }) => r), vaultGated: gated, violations }, null, 2));
  } else {
    console.log(`# Skipped tests (${sites.length}: ${e2eCount} in e2e/, at most ${MAX_E2E_SKIPS}; ${sites.length - e2eCount} in src/)\n`);
    console.log("| Where | Call | Kind | Why | Task | Until |\n|---|---|---|---|---|---|");
    for (const r of rows) console.log(`| ${r.file}:${r.line} | \`${r.call}\` | ${r.kind} | ${r.why.replace(/\|/g, "\\|")} | ${r.task} | ${r.until} |`);
    console.log(`\n## Flows that run only in a special setup (not in the default run)\n`);
    for (const r of rows.filter((x) => x.kind === "setup")) console.log(`- ${r.file}:${r.line} — ${r.why}`);
    console.log(`\n## Vault flows not run on WebKit (e2e/_opfs.ts vaultOrSkip: ${gated.length} tests; they fail, not skip, on chromium and firefox)\n`);
    for (const g of gated) console.log(`- ${g.file}: ${g.title}`);
    for (const v of violations) console.error(`${v.file}:${v.line}  [${v.rule}]  ${v.text}`);
  }
  if (violations.length) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
