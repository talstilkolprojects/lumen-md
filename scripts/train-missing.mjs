#!/usr/bin/env node
/**
 * `npm run train:missing` (W10.F7; audit W4.1, W1.1, W6.42): every open PR
 * whose head is not in the train, and what was decided about it.
 *
 * The audit found 48 of the last 100 PRs missing from verify/train-4 with
 * no record of why, and train 1's 11 commits gone from every later train.
 * This lists every open PR (GitHub REST, all pages), asks git whether its
 * head commit is an ancestor of the train's head, and reads the decision for
 * each one that is not from plan/train-missing.json:
 *
 *   { "pr": 235, "head": "<sha the decision is about>", "decision": "in" | "rejected" | "replaced",
 *     "reason": "…", "via": "W10.F4" (for "in": the task or PR that brings it), "by": "…" (for "replaced": what replaces it) }
 *
 * A decision is about one head: when the PR has moved since, the decision
 * is stale and the PR counts as undecided again. The run fails (exit 1)
 * while any PR head outside the train has no current decision.
 *
 *   npm run train:missing [-- --train verify/train-4] [--decisions plan/train-missing.json] [--json]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { currentTrain } from "./lib/trainBase.mjs";

export const DECISIONS = ["in", "rejected", "replaced"];
export const DECISIONS_FILE = "plan/train-missing.json";

/** Every open PR, all pages: `api(path)` returns one page (an array). */
export function openPulls(api, repo) {
  const out = [];
  for (let page = 1; page < 100; page++) {
    const batch = api(`repos/${repo}/pulls?state=open&per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error(`GET pulls page ${page}: not a list`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

/** Problems with the decisions file itself: unknown decision, no reason, no head, "in" without via, "replaced" without by, a PR twice. */
export function checkDecisions(file) {
  const problems = [];
  const list = Array.isArray(file?.decisions) ? file.decisions : null;
  if (!list) return ["the file has no `decisions` list"];
  const seen = new Set();
  for (const [i, d] of list.entries()) {
    const at = `decisions[${i}]${Number.isInteger(d?.pr) ? ` (#${d.pr})` : ""}`;
    if (!Number.isInteger(d?.pr) || d.pr <= 0) problems.push(`${at}: pr is not a PR number`);
    else if (seen.has(d.pr)) problems.push(`${at}: #${d.pr} is decided twice`);
    else seen.add(d.pr);
    if (!DECISIONS.includes(d?.decision)) problems.push(`${at}: decision "${d?.decision}" is not one of ${DECISIONS.join(", ")}`);
    if (typeof d?.reason !== "string" || d.reason.trim().length < 10) problems.push(`${at}: no reason (at least a sentence)`);
    if (typeof d?.head !== "string" || !/^[0-9a-f]{10,40}$/.test(d.head)) problems.push(`${at}: head is not a commit sha (10 to 40 hex)`);
    if (d?.decision === "in" && !(typeof d.via === "string" && d.via.trim())) problems.push(`${at}: "in" names the task or PR that brings it (via)`);
    if (d?.decision === "replaced" && !(typeof d.by === "string" && d.by.trim())) problems.push(`${at}: "replaced" names what replaces it (by)`);
  }
  return problems;
}

/**
 * The verdict: { inTrain, decided, stale, undecided, gone, problems, ok }.
 * `isAncestor(sha)` answers whether a commit is in the train.
 */
export function classify(pulls, file, isAncestor) {
  const problems = checkDecisions(file);
  const byPr = new Map((Array.isArray(file?.decisions) ? file.decisions : []).filter((d) => Number.isInteger(d?.pr)).map((d) => [d.pr, d]));
  const out = { inTrain: [], decided: [], stale: [], undecided: [], gone: [], problems };
  const open = new Set();
  for (const p of [...pulls].sort((a, b) => a.number - b.number)) {
    open.add(p.number);
    const head = p.head?.sha;
    const row = { pr: p.number, head, base: p.base?.ref ?? null, title: p.title ?? "" };
    if (head && isAncestor(head)) {
      out.inTrain.push(row);
      continue;
    }
    const d = byPr.get(p.number);
    if (!d) out.undecided.push(row);
    else if (!head || !head.startsWith(d.head)) out.stale.push({ ...row, decidedHead: d.head, decision: d.decision });
    else out.decided.push({ ...row, decision: d.decision, reason: d.reason, via: d.via, by: d.by });
  }
  for (const d of byPr.values()) if (!open.has(d.pr)) out.gone.push(d.pr);
  out.ok = !out.problems.length && !out.undecided.length && !out.stale.length;
  return out;
}

export function report(v, train) {
  const n = (k) => v[k].length;
  const lines = [`train:missing against ${train}: ${n("inTrain")} open PR heads in the train, ${n("decided")} outside it with a decision, ${n("stale")} stale, ${n("undecided")} undecided.`];
  const count = (d) => v.decided.filter((x) => x.decision === d).length;
  lines.push(`Decisions: in ${count("in")} · rejected ${count("rejected")} · replaced ${count("replaced")}.`);
  for (const p of v.problems) lines.push(`✗ ${DECISIONS_FILE}: ${p}`);
  for (const r of v.stale) lines.push(`✗ #${r.pr} moved to ${r.head.slice(0, 10)} since the decision "${r.decision}" about ${r.decidedHead.slice(0, 10)} (${r.title.slice(0, 70)})`);
  for (const r of v.undecided) lines.push(`✗ #${r.pr} (${r.base}) ${r.head?.slice(0, 10)}: no decision — ${r.title.slice(0, 80)}`);
  if (v.gone.length) lines.push(`Decisions about PRs no longer open (can go): ${v.gone.map((x) => `#${x}`).join(" ")}.`);
  lines.push(v.ok ? "✓ every open PR head is in the train or decided." : "✗ train:missing: add a decision for each PR above (in / rejected / replaced, with a reason).");
  return lines;
}

const gitIn = (cwd) => (...a) => execFileSync("git", a, { cwd, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * Is `sha` an ancestor of `trainHead`? git answers when it has the commit;
 * when it does not, the compare API does (`behind` or `identical`).
 */
export function ancestry({ git, api, repo, trainHead }) {
  return (sha) => {
    try {
      git("merge-base", "--is-ancestor", sha, trainHead);
      return true;
    } catch (e) {
      // why: exit 1 is a plain "no"; anything else (128: unknown commit) asks the API
      if (e?.status === 1) return false;
    }
    const c = api(`repos/${repo}/compare/${trainHead}...${sha}`);
    return c?.status === "behind" || c?.status === "identical";
  };
}

export function run({ cwd = process.cwd(), remote = "origin", train, decisions = DECISIONS_FILE, repo = "talstilkol/lumen-md", api, git = gitIn(cwd) } = {}) {
  const branches = git("for-each-ref", "--format=%(refname:short)", `refs/remotes/${remote}/verify/`).split("\n").filter(Boolean).map((r) => r.slice(remote.length + 1));
  const t = train ?? currentTrain(branches);
  if (!t) throw new Error(`no verify/train(-N) on ${remote}: pass --train`);
  const trainHead = git("rev-parse", `${remote}/${t}`);
  const file = JSON.parse(readFileSync(resolve(cwd, decisions), "utf8"));
  const v = classify(openPulls(api, repo), file, ancestry({ git, api, repo, trainHead }));
  return { train: t, trainHead, ...v, lines: report(v, t) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const ghApi = (path) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 1 << 28 }));
  try {
    const r = run({ train: opt("--train"), decisions: opt("--decisions") ?? DECISIONS_FILE, remote: opt("--remote") ?? "origin", repo: opt("--repo") ?? process.env.GH_REPO ?? "talstilkol/lumen-md", api: ghApi });
    if (argv.includes("--json")) console.log(JSON.stringify(r, null, 2));
    else console.log(r.lines.join("\n"));
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`✗ train:missing: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
}
