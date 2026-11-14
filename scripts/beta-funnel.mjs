#!/usr/bin/env node
/**
 * The beta funnel (plan W6.31), from the reports testers chose to send.
 *
 *   npm run beta:funnel -- --github                 the `beta-report` issues of the repository (gh api)
 *   npm run beta:funnel -- <files or folders…>       saved reports: <folder>/<tester>/<any>.json|.md, or <tester>__<any>.json
 *   … [--json] [--target 50] [--out funnel.md]
 *
 * Reads nothing else: no app data, no analytics (there are none). A tester
 * is the GitHub account that submitted the issue, or the folder / file-name
 * prefix of a saved report.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { funnel, funnelMarkdown } from "./lib/betaFunnel.mjs";

const args = process.argv.slice(2);
const opt = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const valued = new Set(["--target", "--out", "--repo"]);
const inputs = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
const records = [];

if (args.includes("--github")) {
  const repo = opt("--repo") ?? "talstilkol/lumen-md";
  const out = execFileSync("gh", ["api", "--paginate", `repos/${repo}/issues?labels=beta-report&state=all&per_page=100`, "--jq", ".[] | {tester: .user.login, text: .body}"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  for (const line of out.split("\n")) if (line.trim()) records.push(JSON.parse(line));
}

function walk(p, tester) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const n of readdirSync(p).sort()) walk(join(p, n), statSync(join(p, n)).isDirectory() ? n : tester);
    return;
  }
  if (!/\.(json|md|txt)$/.test(p)) return;
  const name = basename(p);
  records.push({ tester: tester ?? (name.includes("__") ? name.slice(0, name.indexOf("__")) : basename(dirname(p))), text: readFileSync(p, "utf8") });
}
for (const p of inputs) walk(p, null);

if (!args.includes("--github") && !inputs.length) {
  console.error("usage: node scripts/beta-funnel.mjs --github | <files or folders…> [--json] [--target 50] [--out funnel.md]");
  process.exit(2);
}
const f = funnel(records, { target: Number(opt("--target") ?? 50) });
const text = args.includes("--json") ? JSON.stringify(f, null, 2) + "\n" : funnelMarkdown(f);
if (opt("--out")) writeFileSync(opt("--out"), text);
else process.stdout.write(text);
