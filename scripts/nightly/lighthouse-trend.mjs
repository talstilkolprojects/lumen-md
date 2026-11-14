#!/usr/bin/env node
/**
 * Lighthouse trend (plan 0.11): desktop and mobile, 3 runs each against the
 * built dist/, the median of each score and metric appended to a JSON
 * history. The history travels between nights in the Actions cache
 * (.github/workflows/lighthouse-trend.yml); nothing is committed.
 *
 *   node scripts/nightly/lighthouse-trend.mjs [history.json]
 *
 * Needs dist/ (npm run build) and Chrome. Writes reports/lighthouse-history.json,
 * reports/lighthouse-trend.md and the job summary.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { median, summary, table, writeReport } from "./lib.mjs";

const LHCI = "@lhci/cli@0.15.1";
const RUNS = Number(process.env.LH_RUNS ?? 3);
const historyIn = process.argv[2] ?? join("reports", "lighthouse-history.json");
const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];
const METRICS = ["first-contentful-paint", "largest-contentful-paint", "total-blocking-time", "cumulative-layout-shift", "speed-index"];

function collect(formFactor) {
  const out = join(".lighthouseci", formFactor);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const base = JSON.parse(readFileSync("lighthouserc.json", "utf8")).ci.collect;
  const settings = { ...base.settings };
  // The checked-in config is the desktop preset; mobile is Lighthouse's default.
  if (formFactor === "mobile") delete settings.preset;
  else settings.preset = "desktop";
  const rc = join(out, "..", `lighthouserc.${formFactor}.json`);
  writeFileSync(rc, JSON.stringify({ ci: { collect: { ...base, numberOfRuns: RUNS, settings } } }, null, 2));
  const res = spawnSync("npx", ["-y", LHCI, "collect", `--config=${rc}`], { stdio: "inherit", env: { ...process.env, LHCI_BUILD_CONTEXT__CURRENT_HASH: process.env.GITHUB_SHA ?? "" } });
  if (res.status !== 0) throw new Error(`lhci collect (${formFactor}) failed with ${res.status}`);
  // lhci collect writes .lighthouseci/lhr-*.json; keep this form factor's apart.
  const lhrs = readdirSync(".lighthouseci")
    .filter((f) => /^lhr-.*\.json$/.test(f))
    .map((f) => {
      const p = join(".lighthouseci", f);
      const lhr = JSON.parse(readFileSync(p, "utf8"));
      rmSync(p);
      return lhr;
    });
  if (!lhrs.length) throw new Error(`lhci collect (${formFactor}) wrote no reports`);
  const scores = Object.fromEntries(CATEGORIES.map((c) => [c, median(lhrs.map((l) => (l.categories[c]?.score ?? NaN) * 100))]));
  const metrics = Object.fromEntries(METRICS.map((m) => [m, median(lhrs.map((l) => l.audits[m]?.numericValue ?? NaN))]));
  return { runs: lhrs.length, scores, metrics };
}

let history = [];
if (existsSync(historyIn)) {
  try {
    history = JSON.parse(readFileSync(historyIn, "utf8"));
    if (!Array.isArray(history)) history = [];
  } catch {
    history = [];
  }
}
const entry = {
  date: new Date().toISOString(),
  sha: process.env.GITHUB_SHA ?? null,
  ref: process.env.GITHUB_REF_NAME ?? null,
  run: process.env.GITHUB_RUN_ID ?? null,
  desktop: collect("desktop"),
  mobile: collect("mobile"),
};
history.push(entry);
history = history.slice(-180); // half a year of nights
writeReport("lighthouse-history.json", history);

const round = (v, d = 0) => (v === null ? "–" : Number(v.toFixed(d)));
const delta = (now, prev) => (prev === null || prev === undefined || now === null ? "" : ` (${now - prev >= 0 ? "+" : ""}${round(now - prev)})`);
const prev = history.length > 1 ? history[history.length - 2] : null;
const lines = [`## Lighthouse trend: median of ${RUNS} runs, ${history.length} night(s) of history`, ""];
for (const ff of ["desktop", "mobile"]) {
  const s = entry[ff].scores;
  lines.push(
    `**${ff}**`,
    "",
    table(
      [...CATEGORIES, "LCP ms", "TBT ms", "CLS"],
      [
        [
          ...CATEGORIES.map((c) => `${round(s[c])}${delta(s[c], prev?.[ff]?.scores?.[c])}`),
          round(entry[ff].metrics["largest-contentful-paint"]),
          round(entry[ff].metrics["total-blocking-time"]),
          round(entry[ff].metrics["cumulative-layout-shift"], 3),
        ],
      ],
    ),
    "",
  );
}
const last = history.slice(-14);
lines.push(
  "Performance over the last nights:",
  "",
  table(["date", "desktop", "mobile"], last.map((h) => [h.date.slice(0, 10), round(h.desktop?.scores?.performance ?? null), round(h.mobile?.scores?.performance ?? null)])),
);
const md = lines.join("\n") + "\n";
writeReport("lighthouse-trend.md", md);
summary(md);
