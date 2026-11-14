#!/usr/bin/env node
/**
 * The nightly runs without GitHub Actions (plan W4.36; 0.5, 0.11, 0.14).
 *
 * One command a scheduler on the owner's machine starts (launchd or cron:
 * docs/dev/nightly.md). Each kind of run writes one sealed report to
 * reports/nightly/<date>-<kind>.json (scripts/nightly/receipt.mjs) and
 * reports/nightly/status.json says where 0.5, 0.11 and 0.14 stand.
 *
 *   flake    e2e ×5 on chromium, firefox and webkit (npm run e2e:flake -- --all --times 5)
 *   perf     build + bundle budget, the @nightly perf project, Lighthouse (when installed)
 *   triage   review triage over the open PRs, and the 0.14 count over the first 20 PRs
 *   weekly   dependency health (audit, outdated, licences) and mutation scores — Sundays:
 *            the critical modules under real vitest with a receipt (W6.16) where the
 *            branch has scripts/mutation/check.mjs, else npm run test:mutation
 *
 *   npm run nightly                          # what is due today: flake, perf, triage (+ weekly on Sunday)
 *   npm run nightly -- --only triage,weekly  # these kinds only
 *   npm run nightly -- --scheduled           # set by the scheduler: trigger "schedule" (0.11 counts these)
 *   npm run nightly -- --commit              # then commit reports/nightly/ ("[skip ci]"; never pushes)
 *   npm run nightly -- --status              # recompute status.json from the reports there
 *   npm run nightly -- --verify <file>…      # check each report's digest and signature
 *   npm run nightly -- --dry-run             # print the plan, run nothing
 *
 * Exit 1 when a step failed (the report is still written and sealed) or a
 * --verify failed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check, keyPath, loadOrCreateKey, seal, sha256 } from "./receipt.mjs";
import { BROWSERS, ciLocalMetric, FLAKE_TIMES, KINDS, planStatus, PROBE } from "./status.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const NIGHTLY_DIR = join(root, "reports", "nightly");
export const PUBLIC_KEY = join(NIGHTLY_DIR, "PUBLIC_KEY.pem");
/** 0.14 counts the PRs opened from this day (when the nightly receipts started). */
export const METRIC_SINCE = "2026-11-12";
const REPO = "talstilkol/lumen-md";

/** The kinds due on a date: every night flake, perf and triage; weekly on Sundays (UTC). */
export function kindsDue(date, only = null) {
  if (only?.length) return KINDS.filter((k) => only.includes(k));
  return KINDS.filter((k) => k !== "weekly" || date.getUTCDay() === 0);
}

/** reports/nightly/<YYYY-MM-DD>-<kind>.json, or -2, -3… when that name is taken. */
export function reportName(dir, date, kind, exists = existsSync) {
  const d = date.toISOString().slice(0, 10);
  for (let i = 1; ; i++) {
    const name = `${d}-${kind}${i > 1 ? `-${i}` : ""}.json`;
    if (!exists(join(dir, name))) return name;
  }
}

/** W6.16: the floor every critical module must reach in the weekly real run (targets.json critical.min). */
export const MUTATION_MIN = 80;
export const MUTATION_RECEIPT = "scripts/mutation/receipt.json";

/**
 * The steps of one kind, as { id, cmd, timeoutMin, optional? }. `has` says
 * whether an npm script exists, `exists` whether a file of the checkout does.
 */
export function stepsFor(kind, has, exists = (f) => existsSync(join(root, f))) {
  switch (kind) {
    case "flake":
      return [{ id: "e2e-flake", cmd: ["npm", "run", "e2e:flake", "--", "--all", "--times", String(FLAKE_TIMES)], timeoutMin: 300 }];
    case "perf":
      return [
        { id: "build", cmd: ["npm", "run", "build"], timeoutMin: 20 },
        { id: "budget", cmd: ["npm", "run", "budget"], timeoutMin: 5 },
        { id: "perf-e2e", cmd: ["npx", "playwright", "test", "--project=perf", "--reporter=json"], timeoutMin: 30, json: "perf" },
        ...(has("lighthouse") ? [{ id: "lighthouse", cmd: ["npm", "run", "lighthouse"], timeoutMin: 20 }] : []),
      ];
    case "triage":
      return [{ id: "review-triage", cmd: ["node", "scripts/nightly/review-triage.mjs", REPO], timeoutMin: 15 }];
    case "weekly":
      return [
        { id: "weekly-health", cmd: ["node", "scripts/nightly/weekly-health.mjs"], timeoutMin: 30 },
        // W6.16: the critical set under real vitest (the default runner), its receipt
        // rewritten, then the preview build's own check of that receipt.
        ...(exists("scripts/mutation/check.mjs")
          ? [
              { id: "mutation-critical", cmd: ["node", "scripts/mutation/run.mjs", "--critical", "--receipt", "--min", String(MUTATION_MIN)], timeoutMin: 240 },
              { id: "mutation-check", cmd: ["node", "scripts/mutation/check.mjs"], timeoutMin: 5 },
            ]
          : has("test:mutation")
            ? [{ id: "mutation", cmd: ["npm", "run", "test:mutation"], timeoutMin: 240 }]
            : []),
      ];
    default:
      throw new Error(`unknown kind ${kind}`);
  }
}

/**
 * The mutation receipt as a weekly report carries it (W6.16): per critical
 * module its score, the runner, and the sha256 of the source and the tests it
 * was measured on. The sealed report is the signed copy.
 */
export function receiptForReport(receipt, min = MUTATION_MIN) {
  if (!receipt?.modules) return null;
  return {
    min,
    modules: Object.entries(receipt.modules).map(([module, m]) => ({ module, score: m.score ?? null, runner: m.runner ?? null, sha256: m.sha256 ?? null, tests: m.tests ?? null })),
  };
}

/** flake-results/<browser>/summary.json → the shape status.mjs reads. */
export function collectFlake(dir) {
  return {
    browsers: BROWSERS.map((browser) => {
      const f = join(dir, browser, "summary.json");
      if (!existsSync(f)) return { browser, missing: true };
      const s = JSON.parse(readFileSync(f, "utf8"));
      return { browser, times: s.times, tests: Object.keys(s.tests ?? {}).length, flaky: s.flaky ?? [], broken: s.broken ?? [] };
    }),
  };
}

/** The perf annotations ("name: value unit") of a Playwright JSON report. */
export function perfAnnotations(report) {
  const out = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? [])
      for (const t of spec.tests ?? []) for (const a of [...(t.annotations ?? []), ...(t.results ?? []).flatMap((r) => r.annotations ?? [])]) if (a.type === "perf") out.push(a.description);
    for (const s of suite.suites ?? []) walk(s);
  };
  for (const s of report?.suites ?? []) walk(s);
  return [...new Set(out)];
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function runStep(step) {
  const t0 = Date.now();
  const r = spawnSync(step.cmd[0], step.cmd.slice(1), { cwd: root, encoding: "utf8", maxBuffer: 256 << 20, timeout: step.timeoutMin * 60_000, env: process.env });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  process.stdout.write(out.split("\n").slice(-15).join("\n") + "\n");
  return {
    id: step.id,
    cmd: step.cmd.join(" "),
    status: r.status ?? (r.error?.code === "ETIMEDOUT" ? "timeout" : String(r.signal ?? r.error?.code ?? "error")),
    ms: Date.now() - t0,
    output: { sha256: sha256(out), bytes: Buffer.byteLength(out), tail: out.replace(/\u001b\[[0-9;]*m/g, "").trim().split("\n").slice(-12) },
    stdout: step.json ? r.stdout : undefined,
  };
}

const ghJson = (path) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] }));

/** The 0.14 inputs from GitHub's REST API: PRs opened since `since`, each commit's Vercel state. */
export function fetchMetricInputs(since, get = ghJson) {
  const prs = [];
  for (let page = 1; page < 30; page++) {
    const batch = get(`repos/${REPO}/pulls?state=all&sort=created&direction=desc&per_page=100&page=${page}`);
    for (const p of batch) if (p.created_at.slice(0, 10) >= since) prs.push({ number: p.number, head: p.head?.ref ?? "", createdAt: p.created_at });
    if (batch.length < 100 || batch.some((p) => p.created_at.slice(0, 10) < since)) break;
  }
  const first = prs.filter((p) => !PROBE.test(p.head)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, 20);
  for (const p of first) {
    const commits = get(`repos/${REPO}/pulls/${p.number}/commits?per_page=100`);
    p.commits = commits.map((c) => {
      const st = get(`repos/${REPO}/commits/${c.sha}/status`);
      return { sha: c.sha, state: (st.statuses ?? []).find((s) => s.context === "Vercel")?.state ?? null };
    });
  }
  return first;
}

function readReports(dir = NIGHTLY_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}-[a-z]+(-\d+)?\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

function writeStatus(privateKeyPem) {
  const reports = readReports();
  const triage = reports.filter((r) => r.kind === "triage" && r.metric).pop();
  const status = seal({ kind: "status", writtenAt: new Date().toISOString(), commit: git(["rev-parse", "HEAD"]), plan: planStatus(reports, triage?.metric ?? null) }, privateKeyPem);
  writeFileSync(join(NIGHTLY_DIR, "status.json"), JSON.stringify(status, null, 2) + "\n");
  const p = status.plan;
  console.log(`status: 0.5 ${p["0.5"].nights}/${p["0.5"].needed} clean nights · 0.11 ${p["0.11"].ran}/${p["0.11"].needed} scheduled kinds · 0.14 ${p["0.14"] ? `${p["0.14"].remoteFailures} preview failures in ${p["0.14"].prs}/${p["0.14"].of} PRs` : "not counted yet"} · W6.16 ${p["W6.16"].weeks}/${p["W6.16"].needed} clean mutation weeks`);
}

function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.includes("--verify")) {
    const files = argv.slice(argv.indexOf("--verify") + 1).filter((a) => !a.startsWith("--"));
    const pub = existsSync(PUBLIC_KEY) ? readFileSync(PUBLIC_KEY, "utf8") : null;
    let bad = 0;
    for (const f of files) {
      const r = check(JSON.parse(readFileSync(f, "utf8")), pub);
      console.log(`${r.ok ? "✓" : "✗"} ${f}${pub ? "" : " (digest only: no PUBLIC_KEY.pem)"}${r.ok ? "" : `: ${r.problems.join("; ")}`}`);
      if (!r.ok) bad++;
    }
    process.exit(bad ? 1 : 0);
  }
  const now = new Date();
  const only = opt("only")?.split(",").filter(Boolean) ?? null;
  const kinds = argv.includes("--status") ? [] : kindsDue(now, only);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const has = (s) => Boolean(pkg.scripts?.[s]);
  if (argv.includes("--dry-run")) {
    for (const k of kinds) console.log(`${k}: ${stepsFor(k, has).map((s) => s.cmd.join(" ")).join(" → ")}`);
    console.log(`reports → ${NIGHTLY_DIR} · key → ${keyPath()}`);
    return;
  }
  mkdirSync(NIGHTLY_DIR, { recursive: true });
  const { privateKeyPem, publicKeyPem } = loadOrCreateKey();
  if (!existsSync(PUBLIC_KEY)) writeFileSync(PUBLIC_KEY, publicKeyPem);
  else if (readFileSync(PUBLIC_KEY, "utf8") !== publicKeyPem) {
    console.error(`✗ ${PUBLIC_KEY} is not the public half of ${keyPath()}: run on the machine that holds the key, or replace the committed key on purpose.`);
    process.exit(2);
  }
  let failed = false;
  for (const kind of kinds) {
    const startedAt = new Date().toISOString();
    console.log(`\n▶ nightly ${kind}`);
    const steps = stepsFor(kind, has).map(runStep);
    const report = {
      version: 1,
      kind,
      trigger: argv.includes("--scheduled") ? "schedule" : "manual",
      startedAt,
      finishedAt: new Date().toISOString(),
      commit: { sha: git(["rev-parse", "HEAD"]), branch: git(["rev-parse", "--abbrev-ref", "HEAD"]), dirty: Boolean(git(["status", "--porcelain", "--untracked-files=no"])) },
      machine: { platform: process.platform, arch: process.arch, node: process.version, cpus: cpus().length },
      steps: steps.map(({ stdout: _s, ...s }) => s),
    };
    if (kind === "flake") report.flake = collectFlake(join(root, "flake-results"));
    if (kind === "perf") {
      const json = steps.find((s) => s.id === "perf-e2e")?.stdout;
      try {
        report.perf = { annotations: perfAnnotations(JSON.parse(json ?? "")) };
      } catch {
        report.perf = { annotations: [], error: "no Playwright JSON report" };
      }
    }
    if (kind === "triage") {
      const f = join(root, "reports", "review-triage.json");
      if (existsSync(f)) {
        const t = JSON.parse(readFileSync(f, "utf8"));
        report.triage = { prs: t.prs?.length ?? 0, totals: t.totals ?? null };
      }
      try {
        report.metric = ciLocalMetric(fetchMetricInputs(METRIC_SINCE), METRIC_SINCE);
        report.steps.push({ id: "ci-local-metric", cmd: "gh api (pulls, commit statuses)", status: 0, ms: 0 });
      } catch (e) {
        report.steps.push({ id: "ci-local-metric", cmd: "gh api (pulls, commit statuses)", status: "error", ms: 0, output: { tail: [String(e.message).slice(0, 300)] } });
      }
    }
    if (kind === "weekly") {
      const f = join(root, "reports", "weekly-health.json");
      if (existsSync(f)) {
        const w = JSON.parse(readFileSync(f, "utf8"));
        report.weekly = { npmAudit: w.npmAudit?.map((a) => ({ dir: a.dir, counts: a.counts })), outdated: w.outdated?.packages?.length ?? null, licences: w.licences?.ok ?? null };
      }
      const m = join(root, "reports", "mutation", "report.json");
      if (existsSync(m)) report.mutation = JSON.parse(readFileSync(m, "utf8")).map((r) => ({ module: r.module, score: r.score ?? null, error: r.error }));
      if (steps.some((s) => s.id === "mutation-critical")) {
        const rf = join(root, MUTATION_RECEIPT);
        report.mutationReceipt = existsSync(rf) ? receiptForReport(JSON.parse(readFileSync(rf, "utf8"))) : null;
        // The signed report keeps the receipt; the clone goes back to the committed one so the next pull applies.
        if (git(["status", "--porcelain", "--", MUTATION_RECEIPT])) git(["checkout", "--", MUTATION_RECEIPT]);
      }
    }
    const name = reportName(NIGHTLY_DIR, new Date(startedAt), kind);
    writeFileSync(join(NIGHTLY_DIR, name), JSON.stringify(seal(report, privateKeyPem), null, 2) + "\n");
    const bad = report.steps.filter((s) => s.status !== 0);
    console.log(`${bad.length ? "✗" : "✓"} ${kind}: reports/nightly/${name}${bad.length ? ` (failed: ${bad.map((s) => s.id).join(", ")})` : ""}`);
    if (bad.length) failed = true;
  }
  writeStatus(privateKeyPem);
  if (argv.includes("--commit")) {
    git(["add", "reports/nightly"]);
    const msg = `chore(nightly): ${kinds.join(", ") || "status"} reports ${now.toISOString().slice(0, 10)} [skip ci]`;
    const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "-m", msg, "--", "reports/nightly"], { cwd: root, stdio: "inherit" });
    if (r.status !== 0) console.error("nothing committed");
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
