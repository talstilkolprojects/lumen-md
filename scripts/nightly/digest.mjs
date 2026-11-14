#!/usr/bin/env node
/**
 * The owner's nightly digest (plan 0.11): a few lines on the review triage
 * (reports/review-triage.json, written just before) and the latest run of
 * each scheduled report workflow. Goes to reports/digest.md and the job
 * summary; with DIGEST_ISSUE set (a repository variable naming an issue,
 * e.g. a pinned "Nightly digest" issue) it also keeps one comment on that
 * issue up to date. Never commits anything.
 *
 *   node scripts/nightly/digest.mjs [owner/repo]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPORTS, summary, writeReport } from "./lib.mjs";

const repo = process.argv[2] ?? process.env.GITHUB_REPOSITORY ?? "talstilkol/lumen-md";
const branch = process.env.DIGEST_BRANCH || process.env.GITHUB_REF_NAME || "main";
const MARKER = "<!-- lumen-nightly-digest -->";
const WORKFLOWS = [
  ["e2e-flake.yml", "e2e flake hunt (5× · 3 browsers)"],
  ["lighthouse-trend.yml", "Lighthouse trend"],
  ["review-triage.yml", "Review triage"],
  ["weekly-health.yml", "Weekly health"],
];

const gh = (args, input) =>
  JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf8", input, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] }) || "null");

function latestRun(file) {
  try {
    const r = gh([`repos/${repo}/actions/workflows/${file}/runs?branch=${encodeURIComponent(branch)}&per_page=5`]);
    // This workflow's own run is still in progress: report the last finished one.
    const run = r.workflow_runs.find((x) => x.status === "completed" && String(x.id) !== process.env.GITHUB_RUN_ID) ?? r.workflow_runs[0];
    return run ? { conclusion: run.conclusion ?? run.status, url: run.html_url, at: run.created_at, event: run.event } : null;
  } catch {
    return null;
  }
}

const lines = [MARKER, `### Lumen nightly digest, ${new Date().toISOString().slice(0, 10)} (${branch})`, ""];
const triageFile = join(REPORTS, "review-triage.json");
if (existsSync(triageFile)) {
  const t = JSON.parse(readFileSync(triageFile, "utf8"));
  const failing = t.prs.filter((p) => p.ci.state === "failing").map((p) => `#${p.number}`);
  const p1 = t.prs.filter((p) => p.unresolved.P0 + p.unresolved.P1 > 0).map((p) => `#${p.number}`);
  lines.push(
    `- **Reviews:** ${t.prs.length} open PRs; unresolved Codex threads P0 ${t.totals.P0}, P1 ${t.totals.P1}, P2 ${t.totals.P2}.${p1.length ? ` P0/P1 on ${p1.slice(0, 12).join(" ")}${p1.length > 12 ? " …" : ""}.` : ""}`,
    `- **CI:** failing on ${failing.length ? failing.slice(0, 12).join(" ") + (failing.length > 12 ? " …" : "") : "none"}.`,
  );
}
for (const [file, label] of WORKFLOWS) {
  if (file === "review-triage.yml") continue;
  const run = latestRun(file);
  lines.push(`- **${label}:** ${run ? `[${run.conclusion}](${run.url}) (${run.at.slice(0, 10)}, ${run.event})` : "no run yet on this branch"}`);
}
lines.push("", "Full reports: the `reports-*` artifacts of each run.");
const md = lines.join("\n") + "\n";
writeReport("digest.md", md);
summary(md.replace(MARKER + "\n", ""));

const issue = process.env.DIGEST_ISSUE;
if (issue) {
  const comments = gh([`repos/${repo}/issues/${issue}/comments?per_page=100`]);
  const mine = comments.find((c) => c.body?.startsWith(MARKER));
  const body = JSON.stringify({ body: md });
  if (mine) gh(["-X", "PATCH", `repos/${repo}/issues/comments/${mine.id}`, "--input", "-"], body);
  else gh(["-X", "POST", `repos/${repo}/issues/${issue}/comments`, "--input", "-"], body);
  console.log(`digest posted on #${issue}`);
}
