/**
 * The performance gate's arithmetic (plan 8.3): the page-side collector,
 * the metrics of one load, the median run, and the thresholds. Plain
 * JavaScript, shared by scripts/perf-gate.mjs and its tests.
 */

/**
 * Installed before the app's own scripts (addInitScript): buffers paint, LCP,
 * layout-shift and long-task entries into window.__perf.
 */
export const COLLECTOR = `(() => {
  const p = (window.__perf = { fcp: null, lcp: null, cls: 0, longTasks: [], lastInput: false });
  const on = (type, fn) => { try { new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true }); } catch {} };
  on("paint", (e) => { if (e.name === "first-contentful-paint") p.fcp = e.startTime; });
  on("largest-contentful-paint", (e) => { p.lcp = e.renderTime || e.loadTime || e.startTime; });
  on("layout-shift", (e) => { if (!e.hadRecentInput) p.cls += e.value; });
  on("longtask", (e) => { p.longTasks.push([e.startTime, e.duration]); });
})();`;

/**
 * One load's metrics from the collector's buffer.
 * - TBT: the part over 50 ms of every long task between FCP and TTI (as Lighthouse).
 * - TTI: the end of the last long task before a quiet window (at least FCP); the driver
 *   waits for that window, so a later task can only come from input, of which there is none.
 */
export function metricsOf(buf, { domContentLoaded = null, ready = null } = {}) {
  const fcp = buf.fcp;
  const tasks = (buf.longTasks ?? []).map(([s, d]) => ({ start: s, end: s + d, d }));
  const afterFcp = tasks.filter((t) => fcp != null && t.end > fcp);
  const tti = fcp == null ? null : Math.max(fcp, domContentLoaded ?? 0, ...afterFcp.map((t) => t.end));
  const tbt = afterFcp.filter((t) => t.end <= tti).reduce((a, t) => a + Math.max(0, t.end - Math.max(t.start, fcp) - 50), 0);
  return { fcp: r1(fcp), lcp: r1(buf.lcp), cls: buf.cls == null ? null : Math.round(buf.cls * 10000) / 10000, tbt: r1(tbt), tti: r1(tti), ready: r1(ready) };
}

const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);

/**
 * Lighthouse's "median-run": the run closest to the median of FCP and TTI (log-distance),
 * so the reported metrics all come from one real load, not a mix.
 */
export function medianRun(runs) {
  const ok = runs.filter((r) => r.fcp != null && r.tti != null);
  if (!ok.length) return null;
  const med = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const mf = med(ok.map((r) => r.fcp));
  const mt = med(ok.map((r) => r.tti));
  const dist = (r) => Math.abs(Math.log(Math.max(r.fcp, 1) / Math.max(mf, 1))) + Math.abs(Math.log(Math.max(r.tti, 1) / Math.max(mt, 1)));
  return ok.reduce((best, r) => (dist(r) < dist(best) ? r : best));
}

/** → [{ metric, value, level: "error" | "warn", limit, ok, target, metTarget }] */
export function evaluate(metrics, assertions) {
  const out = [];
  for (const [metric, a] of Object.entries(assertions)) {
    const value = metrics?.[metric];
    const level = a.error != null ? "error" : "warn";
    const limit = a.error ?? a.warn;
    out.push({ metric, value: value ?? null, level, limit, ok: value != null && value <= limit, target: a.target ?? null, metTarget: a.target == null ? null : value != null && value <= a.target });
  }
  return out;
}

export const failed = (results) => results.some((r) => r.level === "error" && !r.ok);

const unit = (m, v) => (v == null ? "—" : m === "cls" ? String(v) : `${Math.round(v)} ms`);

/** The gate's Markdown summary (one table per profile). */
export function markdown(profiles, { url, runs }) {
  const lines = [`## Performance gate (plan 8.3)`, "", `${url} · ${runs} runs per profile · median run`, ""];
  for (const p of profiles) {
    lines.push(`### ${p.name}${p.median ? "" : " — no complete run"}`, "", "| Metric | Median run | Limit | Level | Target | |", "|---|---|---|---|---|---|");
    for (const r of p.results) lines.push(`| ${r.metric.toUpperCase()} | ${unit(r.metric, r.value)} | ${unit(r.metric, r.limit)} | ${r.level} | ${r.target == null ? "" : unit(r.metric, r.target)} | ${r.ok ? (r.metTarget === false ? "ok (target not met)" : "ok") : r.level === "error" ? "**FAIL**" : "warn"} |`);
    lines.push("", `All runs (FCP / LCP / TTI ms): ${p.runs.map((r) => `${Math.round(r.fcp ?? NaN)} / ${Math.round(r.lcp ?? NaN)} / ${Math.round(r.tti ?? NaN)}`).join(" · ")}`, "");
  }
  return lines.join("\n");
}
