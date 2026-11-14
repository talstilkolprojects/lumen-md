/**
 * The verification factory (plan W6.5): a free second host that runs every
 * test of every verify/* head each night, in three browsers, and leaves a
 * signed receipt per head. Pure functions; scripts/factory/run.mjs does the
 * I/O (git, docker, gh) and scripts/factory/bootstrap.sh installs it.
 *
 * A night:
 *   1. list the heads of verify/* (git ls-remote)
 *   2. for each head that has no full receipt yet: check it out, run the
 *      steps (the commit's own scripts/nightly/plan.mjs when it has one,
 *      GENERIC_STEPS otherwise, plus EXTRA_STEPS), seal a report with the
 *      nightly key (scripts/nightly/receipt.mjs, #455), commit it to the
 *      receipts repository and post one commit status per suite to GitHub
 *   3. for a head that is unchanged, a heartbeat receipt names the full
 *      receipt that already covers that exact commit (no evidence carried
 *      over to another commit: weakness E62)
 *   4. one morning report: what failed, from which PR, what changed since
 *      the previous report for the same branch
 */

export const REPO = "talstilkol/lumen-md";
export const RECEIPTS_REPO = "talstilkol/lumen-md-receipts";
export const BRANCH_GLOB = "verify/*";
export const BROWSERS = ["chromium", "firefox", "webkit"];
export const VITEST_SHARDS = 2;
export const E2E_SHARDS = 4;

/**
 * Suites the offline harnesses cannot run (weakness E65). The full vitest
 * run includes them anyway; the report says explicitly whether each one ran
 * and passed, so "checked by reading" can't hide behind a green total.
 */
export const MUST_RUN_VITEST = [
  "src/__tests__/e2eeUi.test.tsx",
  "src/__tests__/pdfReader.test.tsx",
  "src/__tests__/dictationLocal.test.ts",
  "src/__tests__/vaultEncryption.test.ts",
];

/** `git ls-remote origin 'refs/heads/verify/*'` → [{ branch, sha }], sorted by branch. */
export function parseLsRemote(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = /^([0-9a-f]{40})\s+refs\/heads\/(\S+)$/.exec(line.trim());
    if (m) out.push({ branch: m[2], sha: m[1] });
  }
  return out.sort((a, b) => a.branch.localeCompare(b.branch));
}

/**
 * Which heads get a full run tonight: trains first (verify/train*), then the
 * rest by name; at most `max`. A head whose sha already has a full receipt
 * gets a heartbeat instead, unless `rerun` (the weekly re-run that catches
 * flakes on an unchanged head).
 */
export function planNight(heads, { done = new Set(), max = 3, rerun = false, only = null } = {}) {
  const wanted = heads.filter((h) => !only || only.includes(h.branch));
  const rank = (h) => (/^verify\/train(-\d+)?$/.test(h.branch) ? 0 : 1);
  const ordered = [...wanted].sort((a, b) => rank(a) - rank(b) || a.branch.localeCompare(b.branch));
  const run = [];
  const heartbeat = [];
  const later = [];
  for (const h of ordered) {
    if (done.has(h.sha) && !rerun) heartbeat.push(h);
    else if (run.length < max) run.push(h);
    else later.push(h);
  }
  return { run, heartbeat, later };
}

/**
 * The steps for a commit without scripts/nightly/plan.mjs: the same shape
 * plan.mjs's fullSteps() returns ({ id, group, cmd, env?, parallel?,
 * timeoutMin }). Playwright starts the app with its own webServer here.
 */
export function genericSteps({ vitestShards = VITEST_SHARDS, e2eShards = E2E_SHARDS, browsers = BROWSERS } = {}) {
  const steps = [{ id: "build", group: "build", cmd: ["npm", "run", "build"], timeoutMin: 20 }];
  for (let i = 1; i <= vitestShards; i++)
    steps.push({
      id: `vitest-${i}of${vitestShards}`,
      group: "vitest",
      parallel: true,
      cmd: ["npx", "vitest", "run", `--shard=${i}/${vitestShards}`, "--reporter=default", "--reporter=json", `--outputFile.json=reports/nightly/vitest-${i}of${vitestShards}.json`],
      timeoutMin: 45,
    });
  for (const browser of browsers)
    for (let i = 1; i <= e2eShards; i++)
      steps.push({
        id: `e2e-${browser}-${i}of${e2eShards}`,
        group: "e2e",
        parallel: true,
        cmd: ["npx", "playwright", "test", `--project=${browser}`, `--shard=${i}/${e2eShards}`, "--workers=1", "--reporter=line,json"],
        env: { PLAYWRIGHT_JSON_OUTPUT_NAME: `reports/nightly/e2e-${browser}-${i}of${e2eShards}.json` },
        timeoutMin: 40,
      });
  return steps;
}

/**
 * Steps every night adds to the commit's own plan, when the commit has what
 * they need: the data-safety drill (#470), cargo check of the desktop shell,
 * and the mutation run on Sundays (UTC).
 */
export function extraSteps({ scripts = {}, hasCargo = false, date = new Date() } = {}) {
  const out = [];
  if (scripts["drill:data-safety"]) out.push({ id: "drill-data-safety", group: "drill", cmd: ["npm", "run", "drill:data-safety"], timeoutMin: 60 });
  if (hasCargo) out.push({ id: "cargo-check", group: "cargo", cmd: ["cargo", "check", "--locked", "--manifest-path", "src-tauri/Cargo.toml"], timeoutMin: 45 });
  // Plan W6.45: the responsiveness run on the factory's CPU, gated against that environment's baseline.
  if (scripts["perf:responsiveness"]) out.push({ id: "perf-responsiveness", group: "perf", cmd: ["npm", "run", "perf:responsiveness", "--", "--seal"], timeoutMin: 45 });
  if (scripts["test:mutation"] && date.getUTCDay() === 0) out.push({ id: "mutation", group: "weekly", cmd: ["npm", "run", "test:mutation"], timeoutMin: 240 });
  return out;
}

/** The order groups run in; a group's `parallel` steps run side by side. */
export const GROUP_ORDER = ["build", "vitest", "e2e", "perf", "drill", "cargo", "weekly", "vercel"];

/** Steps → [[group, steps]] in GROUP_ORDER (unknown groups last, in first-seen order). */
export function groupSteps(steps) {
  const seen = [];
  for (const s of steps) if (!seen.includes(s.group)) seen.push(s.group);
  const order = [...GROUP_ORDER.filter((g) => seen.includes(g)), ...seen.filter((g) => !GROUP_ORDER.includes(g))];
  return order.map((g) => [g, steps.filter((s) => s.group === g)]);
}

/** A step that only checks the Vercel project's settings needs a Vercel token the host doesn't hold: leave it out. */
export function hostSteps(steps) {
  return steps.filter((s) => s.group !== "vercel");
}

/**
 * Playwright's JSON report → { expected, unexpected, flaky, skipped, failed: ["e2e/file › title"] }.
 * Spec files are relative to the test directory (`testDir`, ./e2e in this repo).
 */
export function summarizePlaywright(report, testDir = "e2e") {
  if (!report || typeof report !== "object") return null;
  const s = report.stats ?? {};
  const failed = [];
  const repoPath = (f) => (f && !String(f).startsWith(`${testDir}/`) ? `${testDir}/${f}` : f);
  const walk = (suite, file) => {
    const f = suite.file ?? file;
    for (const spec of suite.specs ?? []) for (const t of spec.tests ?? []) if (t.status === "unexpected") failed.push(`${repoPath(spec.file ?? f)} › ${spec.title}`);
    for (const child of suite.suites ?? []) walk(child, f);
  };
  for (const suite of report.suites ?? []) walk(suite, suite.file);
  return { expected: s.expected ?? 0, unexpected: s.unexpected ?? 0, flaky: s.flaky ?? 0, skipped: s.skipped ?? 0, failed: [...new Set(failed)].sort() };
}

/** Vitest's JSON report (jest-shaped) → { files, tests, passed, failed, failedFiles, ran }. */
export function summarizeVitest(report, root = "/lumen/") {
  if (!report || typeof report !== "object") return null;
  const rel = (p) => String(p ?? "").replace(root, "").replace(/^\/+/, "");
  const results = report.testResults ?? [];
  return {
    files: results.length,
    tests: report.numTotalTests ?? 0,
    passed: report.numPassedTests ?? 0,
    failed: report.numFailedTests ?? 0,
    failedFiles: results.filter((r) => r.status === "failed").map((r) => rel(r.name)).sort(),
    ran: results.map((r) => ({ file: rel(r.name), ok: r.status === "passed" })),
  };
}

/**
 * Per suite, from the step results and the parsed reports:
 *   vitest: every shard step exited 0, and the MUST_RUN_VITEST files ran and passed
 *   e2e <browser>: every shard of that browser exited 0
 * → { suites: { name: { ok, detail } }, mustRun: [{ file, ran, ok }] }
 */
export function suiteVerdicts(steps, { vitest = [], e2e = {} } = {}) {
  const suites = {};
  const by = (prefix) => steps.filter((s) => s.id.startsWith(prefix));
  const build = steps.find((s) => s.id === "build");
  if (build) suites.build = { ok: build.status === 0, detail: build.status === 0 ? "ok" : `exit ${build.status}` };
  const vs = by("vitest-");
  const ran = new Map();
  for (const v of vitest.filter(Boolean)) for (const r of v.ran) ran.set(r.file, (ran.get(r.file) ?? true) && r.ok);
  const mustRun = MUST_RUN_VITEST.map((file) => ({ file, ran: ran.has(file), ok: ran.get(file) === true }));
  if (vs.length) {
    const sums = vitest.filter(Boolean);
    const tests = sums.reduce((n, v) => n + v.tests, 0);
    const failed = sums.reduce((n, v) => n + v.failed, 0);
    const missing = mustRun.filter((m) => !m.ran).map((m) => m.file);
    const ok = vs.every((s) => s.status === 0) && sums.length === vs.length && missing.length === 0 && mustRun.every((m) => m.ok);
    suites.vitest = { ok, detail: `${tests - failed}/${tests} tests in ${sums.reduce((n, v) => n + v.files, 0)} files${missing.length ? `; did not run: ${missing.join(", ")}` : ""}` };
  }
  for (const b of BROWSERS) {
    const es = by(`e2e-${b}-`);
    if (!es.length) continue;
    const sums = es.map((s) => e2e[s.id]).filter(Boolean);
    const passed = sums.reduce((n, x) => n + x.expected, 0);
    const failed = sums.reduce((n, x) => n + x.unexpected, 0);
    const flaky = sums.reduce((n, x) => n + x.flaky, 0);
    const ok = es.every((s) => s.status === 0) && sums.length === es.length;
    suites[`e2e ${b}`] = { ok, detail: `${passed} passed, ${failed} failed, ${flaky} flaky${sums.length < es.length ? `; ${es.length - sums.length} shard report(s) missing` : ""}` };
  }
  for (const s of steps.filter((x) => ["drill", "cargo", "weekly", "perf"].includes(x.group))) suites[s.id] = { ok: s.status === 0, detail: s.status === 0 ? "ok" : `exit ${s.status}` };
  return { suites, mustRun };
}

/** The commit statuses for one report: one per suite plus "lumen/factory" for the whole run. */
export function statusesFor(report, targetUrl) {
  const out = [];
  const suites = report.suites ?? {};
  const names = Object.keys(suites);
  for (const name of names) {
    const s = suites[name];
    out.push({ context: `lumen/factory: ${name}`, state: s.ok ? "success" : "failure", description: clip(s.detail), target_url: targetUrl });
  }
  const bad = names.filter((n) => !suites[n].ok);
  out.push({
    context: "lumen/factory",
    state: names.length && !bad.length ? "success" : "failure",
    description: clip(names.length ? (bad.length ? `failed: ${bad.join(", ")}` : `all ${names.length} suites passed (${report.minutes ?? "?"} min)`) : "no suite ran"),
    target_url: targetUrl,
  });
  return out;
}

/** GitHub keeps a status description to 140 characters. */
export const clip = (s, n = 140) => (String(s).length <= n ? String(s) : `${String(s).slice(0, n - 1)}…`);

/** Where a receipt lives in the receipts repository. */
export const receiptPath = (sha, kind, startedAt) => `commits/${sha}/${kind}-${startedAt.replace(/[:.]/g, "-")}.json`;
/** nights/<date>.json and .md; a second run on the same day gets -2, -3… (never overwrites a receipt). */
export function nightName(date, exists) {
  for (let i = 1; ; i++) {
    const stem = `nights/${date}${i > 1 ? `-${i}` : ""}`;
    if (!exists(`${stem}.json`)) return { json: `${stem}.json`, md: `${stem}.md` };
  }
}

/** What changed between two reports of the same branch: newly failing and fixed tests. */
export function diffFailures(prev, next) {
  const list = (r) => new Set(Object.values(r?.failures ?? {}).flat());
  const a = list(prev);
  const b = list(next);
  return { newlyFailing: [...b].filter((x) => !a.has(x)).sort(), fixed: [...a].filter((x) => !b.has(x)).sort() };
}

/**
 * The morning report (Markdown): one section per head that ran, then the
 * heartbeats. `prs` maps a failing file to the PR number that last changed
 * it (best effort; empty when unknown).
 */
export function morningReport({ date, ran = [], heartbeat = [], later = [], prs = {}, previous = {} }) {
  const o = [`# Verification factory — ${date}`, ""];
  if (!ran.length && !heartbeat.length) o.push("Nothing ran tonight.", "");
  for (const r of ran) {
    const bad = Object.entries(r.suites ?? {}).filter(([, s]) => !s.ok);
    o.push(`## ${r.commit.branch} @ \`${r.commit.sha.slice(0, 9)}\` — ${bad.length ? `✗ ${bad.length} suite(s) failed` : "✓ all suites passed"} (${r.minutes} min)`, "");
    o.push("| Suite | Result | Detail |", "|---|---|---|");
    for (const [name, s] of Object.entries(r.suites ?? {})) o.push(`| ${name} | ${s.ok ? "✓" : "✗"} | ${String(s.detail).replace(/\|/g, "\\|")} |`);
    o.push("");
    const failures = Object.entries(r.failures ?? {}).filter(([, xs]) => xs.length);
    if (failures.length) {
      o.push("Failing:", "");
      for (const [suite, xs] of failures)
        for (const x of xs.slice(0, 30)) {
          const file = x.split(" › ")[0];
          o.push(`- ${suite}: ${x}${prs[file] ? ` — last changed in #${prs[file]}` : ""}`);
        }
      o.push("");
    }
    const prev = previous[r.commit.branch];
    if (prev) {
      const d = diffFailures(prev, r);
      o.push(`Since the previous report of ${r.commit.branch} (\`${prev.commit.sha.slice(0, 9)}\`): ${d.newlyFailing.length} newly failing, ${d.fixed.length} fixed.`, "");
      for (const x of d.newlyFailing.slice(0, 20)) o.push(`- new: ${x}`);
      for (const x of d.fixed.slice(0, 20)) o.push(`- fixed: ${x}`);
      if (d.newlyFailing.length || d.fixed.length) o.push("");
    } else o.push(`No earlier report of ${r.commit.branch} to compare with.`, "");
  }
  if (heartbeat.length) {
    o.push("## Unchanged heads", "");
    for (const h of heartbeat) o.push(`- ${h.branch} @ \`${h.sha.slice(0, 9)}\`: covered by ${h.receipt ?? "an earlier receipt"} for this exact commit`);
    o.push("");
  }
  if (later.length) o.push(`Not run tonight (limit reached): ${later.map((h) => h.branch).join(", ")}.`, "");
  return o.join("\n");
}
