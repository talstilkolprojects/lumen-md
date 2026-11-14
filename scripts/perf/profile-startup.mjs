#!/usr/bin/env node
/**
 * Plan 8.1, step 1: where does main-thread blocking come from on mobile?
 *
 *   npx vite preview --port 4747 --strictPort &
 *   node scripts/perf/profile-startup.mjs --url http://localhost:4747/ --runs 3 [--out reports/perf-startup.json]
 *
 * Chromium on a phone viewport (412×823, Preview mode, as phones start)
 * with 4× CPU throttling — Lighthouse's mobile factor — and a V8 CPU
 * profile over load + the settle time. For each scenario it reports TBT as
 * Lighthouse defines it — the part over 50 ms of every long task between
 * first contentful paint and time to interactive, where TTI is the end of
 * the last long task before a 5 s window with none (the network half of
 * Lighthouse's TTI rule is not modelled) — plus TTI, the longest task, and
 * self time by bundle (React, unified, Shiki + its regex WASM, KaTeX,
 * CodeMirror, app, native work). When no 5 s quiet window fits in the
 * settle time, TTI is "not reached" and TBT is the whole window, marked
 * with a "+".
 *
 *   welcome  the default document (what a first visit renders)
 *   tiny     a two-line document: the app shell's own floor, which a
 *            render worker cannot move
 *   source   the default document in Source mode (no preview at all)
 *
 * Numbers are medians over --runs. A shared or loaded machine inflates
 * them; compare scenarios within one run, and use a quiet runner (the
 * `lighthouse` label's CI job) for absolute values.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright";
import { ttiAndTbt } from "./tti.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const url = arg("--url", "http://localhost:4747/");
const runs = Number(arg("--runs", "3"));
const out = arg("--out", "reports/perf-startup.json");
const settle = Number(arg("--settle", "10000"));
const QUIET_MS = 5000; // Lighthouse's TTI quiet window
const executablePath = process.env.CHROMIUM_PATH || undefined;

const TINY = { name: "tiny.md", content: "# Hello\n\nOne short paragraph.\n", dirty: false, workspaceName: null };
const SCENARIOS = { welcome: {}, tiny: { doc: TINY }, source: { mode: "source" } };

const BUCKETS = [
  ["React", /vendor-react/],
  ["unified (remark/rehype)", /vendor-unified|\/pipeline|remarkLumen|rehype/],
  ["Shiki", /vendor-shiki|shiki/],
  ["Shiki regex (WASM)", /^wasm:/],
  ["KaTeX", /katex/i],
  ["CodeMirror", /codemirror/],
  ["app", /\/assets\//],
  ["native (style, layout, DOM, parse)", /^\(+program\)+$/],
  ["garbage collection", /^\(+garbage collector\)+$/],
];
const bucketOf = (u) => (BUCKETS.find(([, re]) => re.test(u)) ?? ["other"])[0];

async function once(state) {
  const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 823 }, deviceScaleFactor: 1.75, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.addInitScript((st) => {
      localStorage.setItem("lumen-tour-done", "1");
      if (Object.keys(st).length) localStorage.setItem("lumen-md", JSON.stringify({ state: st, version: 0 }));
      window.__lt = [];
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration]);
      }).observe({ type: "longtask", buffered: true });
    }, state);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdp.send("Profiler.start");
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(() => document.body.innerText.length > 30, null, { timeout: 60_000 });
    await page.waitForTimeout(settle);
    const { profile } = await cdp.send("Profiler.stop");
    const { lt, fcp } = await page.evaluate(() => ({ lt: window.__lt, fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0 }));
    // TTI / TBT as Lighthouse defines them, over the observed window (scripts/perf/tti.mjs).
    const { tti, reached, tbt, longTasks } = ttiAndTbt(lt, fcp, fcp + settle, QUIET_MS);
    const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
    const self = {};
    profile.samples.forEach((id, i) => {
      const n = nodes.get(id);
      const u = n.callFrame.url.replace(/^https?:\/\/[^/]+/, "") || `(${n.callFrame.functionName || "program"})`;
      if (/^\(+idle\)+$/.test(u)) return;
      const b = bucketOf(u);
      self[b] = (self[b] ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000;
    });
    return { fcp, tti: reached ? tti : NaN, ttiReached: reached, tbt, longest: Math.max(0, ...lt.map(([, d]) => d)), longTasks, self };
  } finally {
    await browser.close();
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
};

const results = {};
for (let r = 0; r < runs; r++) {
  // Interleave the scenarios so a burst of load on the machine hits all of them.
  for (const [name, state] of Object.entries(SCENARIOS)) (results[name] ??= []).push(await once(state));
}
const summary = {};
for (const [name, rs] of Object.entries(results)) {
  const buckets = [...new Set(rs.flatMap((r) => Object.keys(r.self)))];
  summary[name] = {
    runs: rs.length,
    fcp: Math.round(median(rs.map((r) => r.fcp))),
    tbt: Math.round(median(rs.map((r) => r.tbt))),
    tbtAll: rs.map((r) => Math.round(r.tbt)),
    tti: Math.round(median(rs.filter((r) => r.ttiReached).map((r) => r.tti))) || null,
    ttiReached: rs.filter((r) => r.ttiReached).length,
    longest: Math.round(median(rs.map((r) => r.longest))),
    longTasks: median(rs.map((r) => r.longTasks)),
    selfMs: Object.fromEntries(buckets.map((b) => [b, Math.round(median(rs.map((r) => r.self[b] ?? 0)))]).sort((a, b) => b[1] - a[1])),
  };
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ url, runs, cpuThrottling: 4, viewport: "412x823 mobile", summary }, null, 2) + "\n");

const names = Object.keys(summary);
const rows = [...new Set(names.flatMap((n) => Object.keys(summary[n].selfMs)))];
const md = [
  "### Startup profile (4× CPU throttling, 412×823, medians of " + runs + ")",
  "",
  "TBT as Lighthouse defines it: long tasks between FCP and TTI (TTI = the end of the last long task before a 5 s quiet window; network not modelled). A \"+\" means some run never reached TTI within the " + settle / 1000 + " s window, so its TBT counts the whole window.",
  "",
  "| | " + names.join(" | ") + " |",
  "|---|" + names.map(() => "---:").join("|") + "|",
  "| **TBT, FCP → TTI (ms)** | " + names.map((n) => `**${summary[n].tbt}${summary[n].ttiReached < summary[n].runs ? "+" : ""}** (${summary[n].tbtAll.join(", ")})`).join(" | ") + " |",
  "| TTI (ms; runs that reached it) | " + names.map((n) => `${summary[n].tti ?? "not reached"} (${summary[n].ttiReached}/${summary[n].runs})`).join(" | ") + " |",
  "| longest task (ms) | " + names.map((n) => summary[n].longest).join(" | ") + " |",
  "| FCP (ms) | " + names.map((n) => summary[n].fcp).join(" | ") + " |",
  ...rows.map((b) => `| ${b} (self ms) | ` + names.map((n) => summary[n].selfMs[b] ?? 0).join(" | ") + " |"),
  "",
].join("\n");
process.stdout.write(md); // the CI step pipes this into its summary and PR comment
