/**
 * Plan W6.45: the numbers of e2e/inp-devices.spec.ts, the gate and the receipt.
 * Pure; scripts/perf/responsiveness.mjs runs them.
 *
 * A run (reports/perf/responsiveness/<env>.json) holds, per editor (source,
 * wysiwyg), INP p75 (null where the browser has no Event Timing) and
 * keypress → paint p95 in a 50 KB and a 2 MB note. Lower is better for all.
 * `relatedPanel` says whether the related-notes panel (W2.2) was open, as
 * the plan measures it: it re-ranks after every typing pause.
 */

export const REGRESSION = 0.1;
/** Below this a baseline is compared as this (sub-millisecond noise at the floor never fails). */
export const FLOOR_MS = 1;

/** The plan's budgets (W6.45 acceptance), by environment class. */
export const BUDGETS = { inpDesktop: 100, inpPhone: 200, k2p50KB: 16, k2p2MB: 33 };

/** "source.inpP75" → value, for every number a run has. */
export function flatten(run) {
  const out = {};
  for (const [editor, r] of Object.entries(run?.editors ?? {})) {
    if (typeof r?.inpP75 === "number") out[`${editor}.inpP75`] = r.inpP75;
    for (const [size, v] of Object.entries(r?.k2pP95 ?? {})) if (typeof v === "number") out[`${editor}.k2pP95.${size}`] = v;
  }
  return out;
}

/**
 * The gate: one row per metric in both runs; `regressed` when the latest is
 * at least baseline × (1 + threshold), so an exact 10 % regression fails.
 * Runs of different environments are never compared.
 */
export function compareRuns(baseline, latest, threshold = REGRESSION) {
  if (baseline?.env !== latest?.env) throw new Error(`baseline is for "${baseline?.env}", the run for "${latest?.env}"`);
  // A run with the related-notes panel does more work per keystroke than one without: a new baseline, not a regression.
  if (!!baseline?.relatedPanel !== !!latest?.relatedPanel)
    throw new Error(`baseline ${baseline?.relatedPanel ? "had" : "did not have"} the related-notes panel open, the run ${latest?.relatedPanel ? "had" : "did not"}: re-baseline it (node scripts/perf/responsiveness.mjs gate --update)`);
  const b = flatten(baseline);
  const l = flatten(latest);
  const rows = Object.keys(b)
    .filter((k) => k in l)
    .map((k) => {
      const base = Math.max(b[k], FLOOR_MS);
      const change = (l[k] - base) / base;
      return { metric: k, baseline: b[k], latest: l[k], change, regressed: change >= threshold };
    });
  const missing = Object.keys(b).filter((k) => !(k in l));
  return { rows, missing, ok: rows.every((r) => !r.regressed) && missing.length === 0 };
}

/** Budget misses of a run (absolute targets, separate from the regression gate). */
export function budgetMisses(run) {
  const misses = [];
  const inpBudget = run?.inpBudget ?? (run?.cpuSlowdown > 1 ? BUDGETS.inpPhone : BUDGETS.inpDesktop);
  for (const [editor, r] of Object.entries(run?.editors ?? {})) {
    if (typeof r.inpP75 === "number" && r.inpP75 >= inpBudget) misses.push(`${editor} INP p75 ${r.inpP75.toFixed(1)} ms ≥ ${inpBudget}`);
    if (r.k2pP95?.["50KB"] >= BUDGETS.k2p50KB) misses.push(`${editor} keypress→paint p95 50 KB ${r.k2pP95["50KB"].toFixed(1)} ms ≥ ${BUDGETS.k2p50KB}`);
    if (r.k2pP95?.["2MB"] >= BUDGETS.k2p2MB) misses.push(`${editor} keypress→paint p95 2 MB ${r.k2pP95["2MB"].toFixed(1)} ms ≥ ${BUDGETS.k2p2MB}`);
  }
  return misses;
}

const worst = (xs) => (xs.length ? Math.max(...xs) : undefined);

/**
 * The area-board metrics (scripts/plan/area-bars.mjs, #513) a set of runs
 * proves. The worse of the two editors counts. Only `scored` runs give the
 * board's ids, and only with the related-notes panel open: "perf.inp-p75-ms" from a desktop run (CPU as is),
 * "perf.inp-p75-mid-phone-ms" from a phone (real or CPU-slowed), and the
 * keypress → paint ids from either, the worst environment winning. A run
 * that is not scored (the offline harness) gives its numbers under
 * "perf.unscored.<env>.*", which no bar reads.
 */
export function boardMetrics(runs) {
  const metrics = {};
  const put = (id, v) => {
    if (typeof v !== "number") return;
    metrics[id] = Math.round(Math.max(metrics[id] ?? -Infinity, v) * 10) / 10;
  };
  for (const run of runs) {
    const eds = Object.values(run.editors ?? {});
    const inp = worst(eds.map((e) => e.inpP75).filter((v) => typeof v === "number"));
    const k50 = worst(eds.map((e) => e.k2pP95?.["50KB"]).filter((v) => typeof v === "number"));
    const k2m = worst(eds.map((e) => e.k2pP95?.["2MB"]).filter((v) => typeof v === "number"));
    // The plan measures with the related-notes panel open (W2.2); a run without it proves no board number.
    if (!run.scored || !run.relatedPanel) {
      const p = `perf.unscored.${run.env}`;
      put(`${p}.inp-p75-ms`, inp);
      put(`${p}.key2paint-p95-50kb-ms`, k50);
      put(`${p}.key2paint-p95-2mb-ms`, k2m);
      continue;
    }
    const phone = run.cpuSlowdown > 1 || /phone|pixel|iphone|android|ios/i.test(`${run.env} ${run.device}`);
    put(phone ? "perf.inp-p75-mid-phone-ms" : "perf.inp-p75-ms", inp);
    put("perf.key2paint-p95-50kb-ms", k50);
    put("perf.key2paint-p95-2mb-ms", k2m);
  }
  return metrics;
}

/**
 * The unsealed lumen-metric receipt (format of scripts/plan/areas.mjs, #513):
 * { format, version, kind, commit: { sha }, measuredAt, metrics, command,
 *   environments: [...] } — seal it with scripts/nightly/receipt.mjs.
 */
export function metricReceipt(runs, { sha, command, measuredAt = new Date().toISOString() }) {
  return {
    format: "lumen-metric",
    version: 1,
    kind: "metric",
    task: "W6.45",
    commit: { sha },
    measuredAt,
    metrics: boardMetrics(runs),
    command,
    environments: runs.map((r) => ({ env: r.env, device: r.device, cpuSlowdown: r.cpuSlowdown, scored: !!r.scored, relatedPanel: !!r.relatedPanel, eventTiming: !!r.eventTiming, vaultNotes: r.vaultNotes, at: r.at })),
  };
}

/** Phones for the real-device run on BrowserStack (#510's SDK path). Edit the names when BrowserStack retires one. */
export const PERF_PLATFORMS = [
  { name: "android chrome (Google Pixel 8)", os: "android", deviceName: "Google Pixel 8", osVersion: "14.0", browserName: "chrome" },
  { name: "safari ios 18 (iPhone 16)", os: "ios", deviceName: "iPhone 16", osVersion: "18", browserName: "safari" },
];
