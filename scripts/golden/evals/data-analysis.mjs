#!/usr/bin/env node
/**
 * Data analyst (plan 6.15) on the data-analysis golden set (7.10): numeric
 * answers per question, scored by the set's rule (exact for integers and
 * YYYY-MM, |error| ≤ tolerance for decimals). Acceptance: ≥ 85 % correct on
 * 20 golden questions with a real model (Tal, 15.13).
 *
 *   node scripts/golden/evals/data-analysis.mjs --dev [--programs reference|model] [--out scores.json]
 *
 * Every program runs through the run_python sandbox's own handler
 * (src/agents/python/handler.ts: the seal, the inputs prelude, the output
 * budget) on Pyodide in Node, twice, and both runs must agree (6.15.2) —
 * the path the app takes, minus the Worker.
 *
 *   --programs reference  hand-written programs for the dev questions
 *                         (scripts/golden/evals/data-analysis.reference.mjs):
 *                         proves the sandbox, the CSV hand-off, the answer
 *                         contract and the scoring end to end. NOT the
 *                         model's score.
 *   --programs model      the analyst agent's programs from a running
 *                         Ollama (OLLAMA_URL, ANALYST_MODEL): the real score.
 *                         Not runnable here (no model on this machine).
 *
 * Prints scores only.
 */
import { join } from "node:path";
import { createRequire } from "node:module";
import { tsImport } from "tsx/esm/api";
import { loadSet } from "../../lib/golden.mjs";
import { GOLDEN, ROOT } from "../common.mjs";
import { REFERENCE_PROGRAMS } from "./data-analysis.reference.mjs";

const require = createRequire(join(ROOT, "package.json"));

async function sandbox() {
  const { createPythonHandler } = await tsImport(join(ROOT, "src/agents/python/handler.ts"), import.meta.url);
  const { loadPyodide } = require("pyodide");
  const py = await loadPyodide();
  // A fresh interpreter per run would cost seconds each; isolate runs by clearing the globals instead.
  return async (code, inputs) =>
    new Promise((resolve) => {
      const handle = createPythonHandler({
        loadPyodide: async () => {
          await py.runPythonAsync("for __k in [k for k in list(globals()) if not k.startswith('__')]: del globals()[__k]");
          return py;
        },
        seal: () => {},
        post: (m) => {
          if (m.type === "done") resolve({ ok: !m.error, stdout: m.stdout, stderr: m.stderr, result: m.result, error: m.error, timedOut: false, truncated: m.truncated, blocked: [], ms: 0 });
          if (m.type === "fatal") resolve({ ok: false, stdout: "", stderr: "", result: null, error: m.message, timedOut: false, truncated: false, blocked: [], ms: 0 });
        },
      });
      void handle({ type: "run", code, inputsJson: JSON.stringify(inputs) });
    });
}

const isMain = process.argv[1]?.endsWith("evals/data-analysis.mjs");
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  if (!args.includes("--dev")) {
    console.error("usage: data-analysis.mjs --dev [--programs reference|model] [--out scores.json]");
    process.exit(2);
  }
  const mode = opt("--programs", "reference");
  const { items, corpus } = loadSet(GOLDEN, "data-analysis", { split: "dev" });
  const table = Object.values(corpus ?? {})[0]?.table ?? (await import(join(GOLDEN, "data-analysis/dev/rose.json"), { with: { type: "json" } })).default.table;
  const csv = table.csv;
  const { analyse, matchesGolden } = await tsImport(join(ROOT, "src/agents/analyst.ts"), import.meta.url);
  const report = { set: "data-analysis", split: "dev", programs: mode, items: items.length, target: 0.85 };
  if (mode === "model") {
    report.notRunnable = "needs a real model (Tal's 15.13): no Ollama on this machine";
  } else {
    const run = await sandbox();
    let correct = 0;
    const missing = [];
    const kinds = {};
    for (const it of items) {
      const code = REFERENCE_PROGRAMS[it.id];
      if (!code) {
        missing.push(it.id);
        continue;
      }
      let good = false;
      try {
        const r = await analyse(it.question, csv, { writeCode: async () => code, run: (c, inputs) => run(c, inputs) });
        good = matchesGolden(r.answer.answer, it.answer, it.tolerance);
      } catch {
        good = false;
      }
      kinds[it.kind] = kinds[it.kind] ?? { n: 0, correct: 0 };
      kinds[it.kind].n++;
      if (good) {
        correct++;
        kinds[it.kind].correct++;
      }
    }
    Object.assign(report, { correct, accuracy: items.length ? correct / items.length : 0, kinds, missing, note: "reference programs: validates the pipeline, not a model score" });
  }
  const out = opt("--out");
  if (out) (await import("node:fs")).writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
