#!/usr/bin/env node
/**
 * `npm run train:status` (plan W6.42): where the current train stands
 * against the weekly cadence.
 *
 *   npm run train:status [-- --train verify/train-3] [--no-api] [--json]
 *
 * - The train: the highest verify/train(-N) on the remote (or --train), its
 *   head, its age, and how far it is ahead of main.
 * - The ledger: the PRs merged into it ("Merge #N …" subjects) and how each
 *   was resolved, from the `Train-Resolution:` trailers train:build writes
 *   (clean / auto / manual; "unknown" for merges made before W6.42).
 *   Target: ≤ 10 by hand per weekly train.
 * - The cadence: when main last moved (target: every 7 days), and the next
 *   cut (Sunday).
 * - The gates of the head: the Vercel status (GitHub REST), a nightly
 *   receipt committed for that commit (reports/nightly/*.json), and the
 *   data drill (by hand).
 * - The queue: open PRs on the train or main that the train doesn't have
 *   yet, and the median age of the open PRs it carries (target ≤ 7 days to main).
 *
 * --no-api skips everything that needs the GitHub API.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseMerge } from "./lib.mjs";

/** PRs never merged into a train (#109 carries the old domain); kept in step with build.mjs. */
const NEVER = new Set([109]);

/** An integration train branch: verify/train, verify/train-2, … */
const TRAIN_RE = /^verify\/train(?:-(\d+))?$/;
export const WEEK_DAYS = 7;
export const HAND_TARGET = 10;
/** The weekly cut: Sunday (0), the first day of the working week in Israel. */
export const CUT_DAY = 0;

export function currentTrain(branches) {
  let best = null;
  for (const b of branches) {
    const m = TRAIN_RE.exec(b);
    if (!m) continue;
    const n = Number(m[1] ?? 1);
    if (!best || n > best.n) best = { n, b };
  }
  return best?.b ?? null;
}

/** The train before `train` among `branches`: verify/train-3 → verify/train-2, verify/train-2 → verify/train. */
export function previousTrain(train, branches) {
  const m = TRAIN_RE.exec(train);
  if (!m) return null;
  const n = Number(m[1] ?? 1);
  for (let k = n - 1; k >= 1; k--) {
    const name = k === 1 ? "verify/train" : `verify/train-${k}`;
    if (branches.includes(name)) return name;
  }
  return null;
}

/** The next cut on or after `now` (UTC date) → YYYY-MM-DD. */
export function nextCut(now, day = CUT_DAY) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + ((day - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

export const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** `git log --first-parent --format=%s%x1f%b%x1e main..train` → merges [{ pr, branch, resolution, files }]. */
export function ledgerOf(logText) {
  return logText
    .split("\x1e")
    .map((r) => r.replace(/^\n/, ""))
    .filter(Boolean)
    .map((r) => {
      const [subject, body = ""] = r.split("\x1f");
      return parseMerge(subject.trim(), body);
    })
    .filter(Boolean);
}

/** Counts per resolution. */
export function tally(merges) {
  const c = { clean: 0, auto: 0, manual: 0, unknown: 0 };
  for (const m of merges) c[m.resolution]++;
  return c;
}

/** The report lines and the verdicts, from gathered facts (pure, for the tests). */
export function report(f) {
  const days = (ms) => Math.floor(ms / 86_400_000);
  const lines = [];
  const warn = [];
  lines.push(`Train ${f.train} @ ${f.head.slice(0, 9)} (${f.headDate.slice(0, 10)}, ${days(f.now - Date.parse(f.headDate))} days old), ${f.ahead} commits ahead of main.`);
  const c = tally(f.merges);
  lines.push(`Ledger (since ${f.since ?? "main"}): ${f.merges.length} PRs merged: ${c.clean} clean, ${c.auto} by the resolver, ${c.manual} by hand${c.unknown ? `, ${c.unknown} from before the ledger` : ""}.`);
  if (c.manual > HAND_TARGET) warn.push(`${c.manual} hand resolutions: the weekly target is ≤ ${HAND_TARGET}. Smaller trains, and every PR on the train head (W6.22).`);
  if (f.merges.length > 15) warn.push(`${f.merges.length} PRs in one train: a weekly train holds ≤ 15.`);
  const mainAge = days(f.now - Date.parse(f.mainDate));
  lines.push(`main @ ${f.main.slice(0, 9)} last moved ${f.mainDate.slice(0, 10)} (${mainAge} days ago; the target is at most ${WEEK_DAYS}). Next cut: ${nextCut(new Date(f.now))} (Sunday).`);
  if (mainAge > WEEK_DAYS) warn.push(`main hasn't moved for ${mainAge} days: promote a train that passes its gates.`);
  const gate = (name, v) => lines.push(`  ${v === true ? "✓" : v === false ? "✗" : "…"} ${name}${typeof v === "string" ? `: ${v}` : ""}`);
  lines.push("Gates for the head:");
  gate("Vercel", f.vercel === "success" ? true : f.vercel === "failure" || f.vercel === "error" ? false : f.vercel ?? "not read (--no-api)");
  gate("Nightly receipt", f.nightly ? true : "owed: npm run nightly on the train head, then commit reports/nightly/");
  gate("Data drill", "by hand (record it in the train PR)");
  if (f.queue) {
    lines.push(`Queue: ${f.queue.waiting.length} open PRs on ${f.train} or main not in the train yet${f.queue.waiting.length ? ` (${f.queue.waiting.slice(0, 15).map((n) => `#${n}`).join(" ")}${f.queue.waiting.length > 15 ? " …" : ""})` : ""}.`);
    const med = median(f.queue.inTrainAges);
    if (med != null) {
      lines.push(`Open PRs in the train: ${f.queue.inTrainAges.length}, median age ${Math.round(med)} days (target ≤ ${WEEK_DAYS} to main).`);
      if (med > WEEK_DAYS) warn.push(`the PRs in the train are ${Math.round(med)} days old at the median: promote it.`);
    }
  }
  return { lines: [...lines, ...(warn.length ? ["", ...warn.map((w) => `⚠ ${w}`)] : ["", "✓ on cadence."])], warnings: warn, counts: c };
}

const gitIn = (cwd) => (...a) => execFileSync("git", a, { cwd, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] }).trim();
const ghApi = (path) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 1 << 28 }));

/** The facts for report(), from git (and the API unless noApi). */
export function gather({ cwd, remote = "origin", train, mainRef, noApi = false, repo = "talstilkol/lumen-md", now = Date.now(), api = ghApi }) {
  const git = gitIn(cwd);
  const branches = git("for-each-ref", "--format=%(refname:short)", `refs/remotes/${remote}/verify/`).split("\n").filter(Boolean).map((r) => r.slice(remote.length + 1));
  const t = train ?? currentTrain(branches);
  if (!t) throw new Error(`no verify/train(-N) on ${remote}: pass --train`);
  const T = `${remote}/${t}`;
  const M = mainRef ?? `${remote}/main`;
  const head = git("rev-parse", T);
  // This train's own merges: since the train before it (verify/train-(N-1)), else since main.
  const prev = previousTrain(t, branches);
  const since = prev ? `${remote}/${prev}` : M;
  const merges = ledgerOf(git("log", "--first-parent", "--format=%s%x1f%b%x1e", `${since}..${T}`));
  // A nightly receipt for this exact commit, committed in the train.
  let nightly = false;
  let receipts = [];
  try {
    receipts = git("ls-tree", "--name-only", `${T}:reports/nightly/`).split("\n").filter((x) => x.endsWith(".json"));
  } catch {
    receipts = []; // why: the train has no reports/nightly/ yet
  }
  for (const f of receipts) {
    try {
      if (JSON.parse(git("show", `${T}:reports/nightly/${f}`)).commit?.sha === head) nightly = true;
    } catch {
      // why: not a receipt (status.json has another shape) or unreadable
    }
  }
  const facts = {
    train: t,
    head,
    headDate: git("show", "-s", "--format=%cI", T),
    ahead: Number(git("rev-list", "--count", `${M}..${T}`)),
    main: git("rev-parse", M),
    mainDate: git("show", "-s", "--format=%cI", M),
    since: prev ?? "main",
    merges,
    nightly,
    vercel: null,
    queue: null,
    now,
  };
  if (!noApi) {
    facts.vercel = (api(`repos/${repo}/commits/${head}/status`).statuses ?? []).find((s) => s.context === "Vercel")?.state ?? "no status";
    const open = [];
    for (let page = 1; page < 50; page++) {
      const batch = api(`repos/${repo}/pulls?state=open&per_page=100&page=${page}`);
      open.push(...batch);
      if (batch.length < 100) break;
    }
    const inTrain = new Set(merges.map((m) => m.pr));
    facts.queue = {
      waiting: open.filter((p) => (p.base.ref === t || p.base.ref === "main") && !inTrain.has(p.number) && !NEVER.has(p.number) && !String(p.user?.login ?? "").includes("dependabot")).map((p) => p.number).sort((a, b) => a - b),
      inTrainAges: open.filter((p) => inTrain.has(p.number)).map((p) => (now - Date.parse(p.created_at)) / 86_400_000),
    };
  }
  return facts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  try {
    const f = gather({ cwd: process.cwd(), remote: opt("--remote") ?? "origin", train: opt("--train"), noApi: argv.includes("--no-api"), repo: opt("--repo") ?? process.env.GH_REPO ?? "talstilkol/lumen-md" });
    const r = report(f);
    if (argv.includes("--json")) console.log(JSON.stringify({ ...f, ...r }, null, 2));
    else console.log(r.lines.join("\n"));
  } catch (e) {
    console.error(`✗ train:status: ${e.message}`);
    process.exit(2);
  }
}
