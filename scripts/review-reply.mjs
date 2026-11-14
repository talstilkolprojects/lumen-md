#!/usr/bin/env node
/**
 * Answer review threads from a decisions table (docs/dev/lanes.md):
 *
 *   comment_id<TAB>verdict<TAB>sha<TAB>reason     verdict: fixed | already-fixed | wontfix
 *
 * For every row: reply on the thread, then resolve it (fixed / already-fixed;
 * wontfix threads stay open for the reviewer). Handled ids are recorded in
 * reports/review-replied.txt, so a rerun skips them.
 *
 * DRY RUN BY DEFAULT — prints what it would post. Add --go to post.
 *
 * Usage:
 *   node scripts/review-reply.mjs decisions.tsv --pr-fix 200          # dry run
 *   node scripts/review-reply.mjs decisions.tsv --pr-fix 200 --go     # post
 *   [--triage reports/review-triage.json]  comment → PR map (else each comment is looked up)
 *
 * REST only, through the `gh` CLI.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildReplyBody, parseDecisions, parseReplied, prFromUrl, shouldResolve } from "./lib/review.mjs";

const usage = "usage: node scripts/review-reply.mjs <decisions.tsv> --pr-fix <N> [--go] [--triage file]";
const argv = process.argv.slice(2);
let file = null;
let prFix = null;
let go = false;
let triagePath = "reports/review-triage.json";
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--go") go = true;
  else if (a === "--pr-fix") prFix = argv[++i];
  else if (a.startsWith("--pr-fix=")) prFix = a.slice(9);
  else if (a === "--triage") triagePath = argv[++i];
  else if (a.startsWith("--triage=")) triagePath = a.slice(9);
  else if (!a.startsWith("--") && !file) file = a;
  else {
    console.error(`unknown argument: ${a}\n${usage}`);
    process.exit(2);
  }
}
if (!file || !/^\d+$/.test(String(prFix ?? ""))) {
  console.error(usage);
  process.exit(2);
}
prFix = Number(prFix);

const { rows, errors } = parseDecisions(readFileSync(file, "utf8"));
if (errors.length) {
  console.error(`${file}: ${errors.length} problem(s), nothing posted:`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

const run = (a) => execFileSync("gh", ["api", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
const remote = process.env.GH_REPO || execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
const repo = remote.replace(/\.git$/, "").split(/[/:]/).slice(-2).join("/");
const errText = (e) => String(e?.stderr || e?.message || e).trim().split("\n")[0];

// comment id → { pr, root } from the triage report; replies map to their thread's first comment.
const known = new Map();
let triagePrs = new Set();
if (existsSync(triagePath)) {
  const t = JSON.parse(readFileSync(triagePath, "utf8"));
  triagePrs = new Set((t.prs ?? []).map((p) => p.number));
  for (const th of t.threads ?? []) {
    for (const id of th.comment_ids ?? [th.comment_id]) known.set(Number(id), { pr: th.pr, root: th.comment_id, open: true });
  }
}
function locate(id) {
  if (known.has(id)) return known.get(id);
  const c = JSON.parse(run([`repos/${repo}/pulls/comments/${id}`]));
  const pr = prFromUrl(c.pull_request_url);
  if (!pr) throw new Error(`comment ${id} has no pull request`);
  // Not in the report's unresolved list although its PR was triaged → probably resolved already.
  return { pr, root: c.in_reply_to_id ?? id, open: !triagePrs.has(pr) };
}

const repliedPath = resolve("reports/review-replied.txt");
const state = parseReplied(existsSync(repliedPath) ? readFileSync(repliedPath, "utf8") : "");
const record = (id, mark = "") => {
  mkdirSync(dirname(repliedPath), { recursive: true });
  appendFileSync(repliedPath, `${id}${mark ? ` ${mark}` : ""}\n`);
};

console.log(go ? `Posting to ${repo} (fixes in #${prFix})…` : `DRY RUN — nothing is posted. ${repo}, fixes in #${prFix}. Add --go to post.`);
let posted = 0;
let resolved = 0;
let skipped = 0;
let failed = 0;
for (const d of rows) {
  const prev = state.get(d.comment_id);
  if (prev === "done") {
    skipped++;
    continue;
  }
  let where;
  try {
    where = locate(d.comment_id);
  } catch (e) {
    failed++;
    console.log(`\n✗ comment ${d.comment_id} (${file}:${d.line}): not found — ${errText(e)}`);
    continue;
  }
  const { pr, root } = where;
  const resolveIt = shouldResolve(d.verdict);
  const body = buildReplyBody(d, prFix);
  const what = prev === "replied" ? "resolve only (reply already posted)" : resolveIt ? "reply + resolve" : "reply, leave open";
  console.log(`\n#${pr} · comment ${root}${root !== d.comment_id ? ` (thread of ${d.comment_id})` : ""} · ${d.verdict} → ${what}`);
  if (!where.open) console.log("  ! not in the triage report's unresolved threads — already resolved, or the report is stale");
  if (prev !== "replied") for (const l of body.split("\n")) console.log(`  │ ${l}`);
  if (!go) continue;

  if (prev !== "replied") {
    try {
      run(["-X", "POST", `repos/${repo}/pulls/${pr}/comments/${root}/replies`, "-f", `body=${body}`]);
      posted++;
    } catch (e) {
      failed++;
      console.log(`  ✗ reply failed: ${errText(e)}`);
      continue;
    }
  }
  if (!resolveIt) {
    record(d.comment_id);
    console.log("  ✓ replied");
    continue;
  }
  try {
    run(["-X", "POST", `repos/${repo}/pulls/${pr}/ccr/comments/${root}/resolve`]);
    resolved++;
    record(d.comment_id);
    console.log(prev === "replied" ? "  ✓ resolved" : "  ✓ replied and resolved");
  } catch (e) {
    failed++;
    if (prev !== "replied") record(d.comment_id, "replied");
    console.log(`  ✗ resolve failed (reply is posted; a rerun retries the resolve): ${errText(e)}`);
  }
}

const todo = rows.length - skipped;
console.log(
  `\n${rows.length} decision(s): ${skipped} already handled` +
    (go ? `, ${posted} replied, ${resolved} resolved, ${failed} failed` : `, ${todo - failed} to post${failed ? `, ${failed} not found` : ""}`) +
    (go ? `. State: ${repliedPath}` : ""),
);
process.exit(failed ? 1 : 0);
