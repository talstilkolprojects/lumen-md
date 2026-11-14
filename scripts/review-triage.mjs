#!/usr/bin/env node
/**
 * Every unresolved review thread across the open PRs, grouped by file: PR,
 * file:line, author, severity (P0–P3 badge when the comment has one), outdated
 * flag and the finding's first line. Prints a table and writes
 * reports/review-triage.json, which `scripts/review-reply.mjs` reads back.
 * REST only, through the `gh` CLI (no GraphQL).
 *
 * Usage:
 *   node scripts/review-triage.mjs                    # all open PRs
 *   node scripts/review-triage.mjs --pr 136 --pr 193  # just these
 *   node scripts/review-triage.mjs --lanes            # + suggested lane (docs/dev/lanes.md)
 *   node scripts/review-triage.mjs --out other.json   # report somewhere else
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { groupByFile, shortAuthor, suggestLane, triageRows } from "./lib/review.mjs";

const argv = process.argv.slice(2);
const only = [];
let showLanes = false;
let out = "reports/review-triage.json";
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--pr") only.push(Number(argv[++i]));
  else if (a.startsWith("--pr=")) only.push(Number(a.slice(5)));
  else if (/^\d+$/.test(a)) only.push(Number(a));
  else if (a === "--lanes") showLanes = true;
  else if (a === "--out") out = argv[++i];
  else if (a.startsWith("--out=")) out = a.slice(6);
  else {
    console.error(`unknown argument: ${a}\nusage: node scripts/review-triage.mjs [--pr N ...] [--lanes] [--out file]`);
    process.exit(2);
  }
}
if (only.some((n) => !Number.isInteger(n) || n <= 0)) {
  console.error("--pr takes a PR number");
  process.exit(2);
}

const run = (a) => execFileSync("gh", ["api", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
const gh = (...a) => JSON.parse(run(a));
/** Every page, one JSON value per `jq` output line. */
const ghAll = (jq, ...a) =>
  run(["--paginate", "--jq", jq, ...a])
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const remote = process.env.GH_REPO || execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
const repo = remote.replace(/\.git$/, "").split(/[/:]/).slice(-2).join("/");
const errText = (e) => String(e?.stderr || e?.message || e).trim().split("\n")[0];

const prs = only.length
  ? only.map((n) => gh(`repos/${repo}/pulls/${n}`))
  : ghAll(".[]", `repos/${repo}/pulls?state=open&per_page=100`);

const rows = [];
const prInfo = [];
for (const p of prs) {
  const info = { number: p.number, title: p.title, head: p.head?.ref, state: p.state, unresolved: 0 };
  prInfo.push(info);
  try {
    const threads = ghAll(".[]", `repos/${repo}/pulls/${p.number}/ccr/review_threads`);
    if (!threads.some((t) => !t.resolved)) continue;
    const comments = new Map(ghAll(".[]", `repos/${repo}/pulls/${p.number}/comments?per_page=100`).map((c) => [c.id, c]));
    const mine = triageRows(p.number, threads, comments).map((r) => ({ ...r, lane: suggestLane(r.path) }));
    info.unresolved = mine.length;
    rows.push(...mine);
  } catch (e) {
    info.error = errText(e);
  }
}

// ── table ─────────────────────────────────────────────────────────────
const width = Math.max(100, process.stdout.columns || 140);
const pad = (s, n) => String(s ?? "").padEnd(n);
const sev = rows.reduce((acc, r) => ((acc[r.severity || "–"] = (acc[r.severity || "–"] ?? 0) + 1), acc), {});
const sevText = Object.entries(sev)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([k, v]) => `${k} ${v}`)
  .join(", ");
const prsWith = prInfo.filter((p) => p.unresolved).length;
console.log(
  `${rows.length} unresolved thread(s) in ${prsWith} of ${prInfo.length} PR(s)` +
    (rows.length ? ` — ${sevText}; outdated ${rows.filter((r) => r.outdated).length}` : ""),
);
for (const p of prInfo.filter((x) => x.error)) console.log(`  ! #${p.number}: threads unavailable (${p.error})`);
for (const p of prInfo.filter((x) => x.state && x.state !== "open")) console.log(`  ! #${p.number} is ${p.state}`);

const head = `  ${pad("PR", 6)}${pad("line", 6)}${pad("sev", 4)}${showLanes ? pad("lane", 5) : ""}${pad("out", 4)}${pad("re", 3)}${pad("author", 14)}${pad("comment", 12)}`;
for (const [path, list] of groupByFile(rows)) {
  console.log(`\n${path || "(no file)"}${showLanes && list[0].lane ? `  [lane ${list[0].lane}]` : ""}`);
  console.log(`${head}finding`);
  for (const r of list) {
    const left =
      `  ${pad(`#${r.pr}`, 6)}${pad(r.line ?? "-", 6)}${pad(r.severity || "-", 4)}` +
      `${showLanes ? pad(r.lane || "?", 5) : ""}${pad(r.outdated ? "yes" : "", 4)}${pad(r.replies || "", 3)}` +
      `${pad(shortAuthor(r.author).slice(0, 13), 14)}${pad(r.comment_id, 12)}`;
    const room = Math.max(20, width - left.length);
    console.log(left + (r.title.length > room ? `${r.title.slice(0, room - 1)}…` : r.title));
  }
}
if (showLanes && rows.length) {
  const byLane = rows.reduce((acc, r) => ((acc[r.lane || "?"] = (acc[r.lane || "?"] ?? 0) + 1), acc), {});
  console.log(`\nlanes: ${Object.entries(byLane).map(([k, v]) => `${k} ${v}`).join(", ")}  (? = no lane owns the path; the coordinator assigns it)`);
}

const dest = resolve(out);
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify({ repo, generated_at: new Date().toISOString(), prs: prInfo, threads: rows }, null, 2) + "\n");
console.log(`\nwrote ${out} (${rows.length} thread(s))`);
