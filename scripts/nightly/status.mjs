/**
 * What the sealed nightly reports in reports/nightly/ say about the plan
 * items whose acceptance was written around GitHub Actions (W4.36):
 *
 *   0.5   three nights in a row with 0 flakes: the e2e flake run on every
 *         browser, 5 times each, with no flaky and no always-failing test
 *   0.11  the four kinds of scheduled run (flake, perf, triage, weekly) each
 *         produced a report without anyone starting it (trigger "schedule")
 *   0.14  over the first 20 pull requests opened since ci:local, how many
 *         preview-build failures (the remote check ci:local mirrors) there were
 *
 * Pure functions over parsed reports; scripts/nightly/run.mjs reads the files
 * and writes reports/nightly/status.json. The coordinator copies the result
 * into the plan.
 */

export const KINDS = ["flake", "perf", "triage", "weekly"];
export const BROWSERS = ["chromium", "firefox", "webkit"];
export const FLAKE_TIMES = 5;
export const NIGHTS_NEEDED = 3;
export const PRS_NEEDED = 20;
/** The coordinator's integration trains and probes (verify/*) are not change PRs: 0.14 leaves them out. */
export const PROBE = /^verify\//;

/** The calendar day (UTC) a report started. */
const day = (r) => String(r.startedAt ?? "").slice(0, 10);
const prevDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** A flake report that counts for 0.5: every browser ran FLAKE_TIMES times, nothing flaky or broken. */
export function cleanNight(r) {
  if (r?.kind !== "flake" || !Array.isArray(r.flake?.browsers)) return false;
  const byName = new Map(r.flake.browsers.map((b) => [b.browser, b]));
  return BROWSERS.every((name) => {
    const b = byName.get(name);
    return b && !b.missing && b.times >= FLAKE_TIMES && b.tests > 0 && b.flaky.length === 0 && b.broken.length === 0;
  });
}

/**
 * 0.5: the longest run of consecutive days, ending at the latest flake
 * report, with a clean night on each (a day with any unclean flake report
 * breaks it).
 */
export function flakeStreak(reports) {
  const flakes = reports.filter((r) => r.kind === "flake");
  const days = new Map();
  for (const r of flakes) {
    const d = day(r);
    days.set(d, (days.get(d) ?? true) && cleanNight(r));
  }
  const sorted = [...days.keys()].sort();
  if (!sorted.length) return { nights: 0, days: [] };
  let d = sorted[sorted.length - 1];
  const run = [];
  while (days.get(d) === true) {
    run.unshift(d);
    d = prevDay(d);
  }
  return { nights: run.length, days: run };
}

/** 0.11: for each kind, the latest scheduled report (or null). */
export function scheduledKinds(reports) {
  const out = {};
  for (const k of KINDS) {
    const mine = reports.filter((r) => r.kind === k && r.trigger === "schedule").sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    const last = mine[mine.length - 1];
    out[k] = last ? { at: last.startedAt, commit: last.commit?.sha ?? null, ok: last.steps?.every((s) => s.status === 0) ?? false } : null;
  }
  return out;
}

/**
 * 0.14 from pull requests and their commits' preview-build states:
 *   prs: [{ number, head, createdAt, commits: [{ sha, state }] }] (state = the
 *   "Vercel" commit status: success | failure | error | pending | null).
 * Takes the first PRS_NEEDED opened on or after `since`, leaving out verify/* heads.
 */
export function ciLocalMetric(prs, since) {
  const counted = prs
    .filter((p) => String(p.createdAt) >= since && !PROBE.test(p.head ?? ""))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.number - b.number)
    .slice(0, PRS_NEEDED);
  const failing = counted
    .map((p) => ({ number: p.number, failures: p.commits.filter((c) => c.state === "failure" || c.state === "error").map((c) => c.sha) }))
    .filter((p) => p.failures.length);
  return {
    since,
    prs: counted.length,
    of: PRS_NEEDED,
    complete: counted.length >= PRS_NEEDED,
    remoteFailures: failing.reduce((n, p) => n + p.failures.length, 0),
    prsWithFailures: failing.map((p) => p.number),
    failing,
  };
}

/** The whole status block for reports/nightly/status.json. */
export function planStatus(reports, metric = null) {
  const streak = flakeStreak(reports);
  const kinds = scheduledKinds(reports);
  const ran = KINDS.filter((k) => kinds[k]);
  return {
    "0.5": { nights: streak.nights, needed: NIGHTS_NEEDED, met: streak.nights >= NIGHTS_NEEDED, days: streak.days },
    "0.11": { kinds, ran: ran.length, needed: KINDS.length, met: ran.length === KINDS.length },
    "0.14": metric ? { ...metric, met: metric.complete && metric.remoteFailures === 0 } : null,
  };
}
