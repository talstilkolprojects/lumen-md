#!/usr/bin/env node
/**
 * Review triage (plan 0.11): every open PR with its unresolved Codex review
 * threads by severity (P0–P3, from the review badge), its CI state on the
 * head commit and its age. Writes reports/review-triage.{json,md} and the
 * job summary.
 *
 *   node scripts/nightly/review-triage.mjs [owner/repo]
 *
 * Uses the `gh` CLI (GH_TOKEN in Actions). Thread resolution is GraphQL-only
 * on GitHub; where GraphQL is not available (some sandboxes) the script
 * falls back to the /pulls/{n}/ccr/review_threads route, and says which it used.
 */
import { execFileSync } from "node:child_process";
import { ageDays, summary, table, writeReport } from "./lib.mjs";

const repo = process.argv[2] ?? process.env.GITHUB_REPOSITORY ?? "talstilkol/lumen-md";
const [owner, name] = repo.split("/");
const SEVERITIES = ["P0", "P1", "P2", "P3"];
const isCodex = (login = "") => /codex/i.test(login);

function gh(args) {
  return JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] }));
}
/** Every page of a REST list. */
function list(path) {
  const out = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const items = gh([`${path}${sep}per_page=100&page=${page}`]);
    const arr = Array.isArray(items) ? items : (items.check_runs ?? []);
    out.push(...arr);
    if (arr.length < 100) return out;
  }
}
const severityOf = (body = "") => body.match(/!\[(P[0-3]) Badge\]/)?.[1] ?? "P?";
const titleOf = (body = "") => (body.split("\n")[0] ?? "").replace(/.*Badge\]\([^)]*\)<\/sub><\/sub>\s*/, "").replace(/\*\*/g, "").trim().slice(0, 90);

let source = "graphql";
function unresolvedThreads(pr) {
  if (source === "graphql") {
    try {
      const q = `query($o:String!,$n:String!,$pr:Int!){repository(owner:$o,name:$n){pullRequest(number:$pr){reviewThreads(first:100){nodes{isResolved isOutdated path comments(first:1){nodes{databaseId body url author{login}}}}}}}}`;
      const res = gh(["graphql", "-f", `query=${q}`, "-f", `o=${owner}`, "-f", `n=${name}`, "-F", `pr=${pr}`]);
      return res.data.repository.pullRequest.reviewThreads.nodes
        .filter((t) => !t.isResolved)
        .map((t) => ({ ...t.comments.nodes[0], login: t.comments.nodes[0]?.author?.login, path: t.path, outdated: t.isOutdated }));
    } catch {
      source = "ccr";
    }
  }
  const threads = gh([`repos/${repo}/pulls/${pr}/ccr/review_threads`]);
  const comments = new Map(list(`repos/${repo}/pulls/${pr}/comments`).map((c) => [c.id, c]));
  return threads
    .filter((t) => !t.resolved)
    .map((t) => {
      const c = comments.get(t.comment_ids[0]) ?? {};
      return { databaseId: c.id, body: c.body, url: c.html_url, login: c.user?.login, path: t.path, outdated: t.outdated };
    });
}

function ciState(sha) {
  const runs = list(`repos/${repo}/commits/${sha}/check-runs?filter=latest`);
  const failing = runs.filter((r) => ["failure", "timed_out", "action_required", "startup_failure"].includes(r.conclusion)).map((r) => r.name);
  const pending = runs.filter((r) => r.status !== "completed").map((r) => r.name);
  const state = failing.length ? "failing" : pending.length ? "pending" : runs.length ? "passing" : "none";
  return { state, failing, pending, total: runs.length };
}

const prs = list(`repos/${repo}/pulls?state=open`);
const rows = prs.map((pr) => {
  const threads = unresolvedThreads(pr.number).filter((t) => isCodex(t.login));
  const bySeverity = Object.fromEntries([...SEVERITIES, "P?"].map((s) => [s, 0]));
  for (const t of threads) bySeverity[severityOf(t.body)]++;
  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    base: pr.base.ref,
    head: pr.head.ref,
    sha: pr.head.sha,
    draft: pr.draft,
    ageDays: ageDays(pr.created_at),
    idleDays: ageDays(pr.updated_at),
    ci: ciState(pr.head.sha),
    unresolved: bySeverity,
    threads: threads.map((t) => ({ id: t.databaseId, severity: severityOf(t.body), title: titleOf(t.body), path: t.path, outdated: t.outdated, url: t.url })),
  };
});
const rank = (r) => [-(r.unresolved.P0 * 1000 + r.unresolved.P1 * 100 + r.unresolved.P2 * 10 + r.unresolved.P3), r.ci.state === "failing" ? 0 : 1, -r.ageDays];
rows.sort((a, b) => {
  const [x, y] = [rank(a), rank(b)];
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return a.number - b.number;
});

const totals = Object.fromEntries(SEVERITIES.map((s) => [s, rows.reduce((n, r) => n + r.unresolved[s], 0)]));
const failing = rows.filter((r) => r.ci.state === "failing");
writeReport("review-triage.json", { date: new Date().toISOString(), repo, threadSource: source, totals, prs: rows });

const ciCell = (ci) => (ci.state === "failing" ? `failing: ${ci.failing.slice(0, 3).join(", ")}${ci.failing.length > 3 ? " …" : ""}` : ci.state);
const lines = [
  `## Review triage: ${rows.length} open PRs, unresolved Codex threads P0 ${totals.P0} · P1 ${totals.P1} · P2 ${totals.P2} · P3 ${totals.P3}; CI failing on ${failing.length}`,
  "",
  table(
    ["PR", "P0", "P1", "P2", "P3", "CI", "age (d)", "idle (d)", "base"],
    rows.map((r) => [`[#${r.number}](${r.url}) ${r.title.slice(0, 60)}`, r.unresolved.P0, r.unresolved.P1, r.unresolved.P2, r.unresolved.P3, ciCell(r.ci), r.ageDays, r.idleDays, r.base]),
  ),
];
const urgent = rows.flatMap((r) => r.threads.filter((t) => t.severity === "P0" || t.severity === "P1").map((t) => [`#${r.number}`, t.severity, `[${t.title || t.id}](${t.url})`, t.path ?? "", t.outdated ? "outdated" : ""]));
if (urgent.length) lines.push("", "### Unresolved P0 / P1 threads", "", table(["PR", "sev", "thread", "file", ""], urgent));
lines.push("", `_Thread state from ${source === "graphql" ? "GraphQL reviewThreads" : "the /ccr/review_threads route"}._`);
const md = lines.join("\n") + "\n";
writeReport("review-triage.md", md);
summary(md);
