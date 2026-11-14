#!/usr/bin/env node
/**
 * `npm run visual:approve -- <suite> [--yes] [--dry-run]` (plan W10.B16).
 *
 * The only way to write visual baselines. A person runs the suite, looks at
 * every new or changed PNG, and approves. Playwright never writes a baseline
 * on its own: both configs take `updateSnapshots` from
 * scripts/lib/visualGate.mjs, which is "none" unless this script set
 * LUMEN_VISUAL_APPROVE=1.
 *
 * Refuses on the gate (CI, LUMEN_CI, LUMEN_GATE). Without --yes it asks you
 * to type "approve" on a terminal; with no terminal it refuses.
 *
 *   suites: visual  (playwright.visual.config.ts: surfaces, RTL, …)
 *           print   (e2e/print-golden.spec.ts)
 *           canvas  (e2e/canvas-note-cards.spec.ts)
 *           slides  (e2e/slides.spec.ts)
 *           smoke   (e2e/visual-smoke.spec.ts, chromium)
 */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { isGateRun } from "./lib/visualGate.mjs";

export const SUITES = {
  visual: { config: "playwright.visual.config.ts", files: [], project: null },
  print: { config: "playwright.config.ts", files: ["e2e/print-golden.spec.ts"], project: "chromium" },
  canvas: { config: "playwright.config.ts", files: ["e2e/canvas-note-cards.spec.ts"], project: "chromium" },
  slides: { config: "playwright.config.ts", files: ["e2e/slides.spec.ts"], project: "chromium" },
  smoke: { config: "playwright.config.ts", files: ["e2e/visual-smoke.spec.ts"], project: "chromium" },
};

/** The command and environment for a suite (exported for the test). */
export function approveCommand(suite, env) {
  const s = SUITES[suite];
  if (!s) return null;
  const args = ["playwright", "test", "-c", s.config, ...s.files, ...(s.project ? ["--project", s.project] : [])];
  return { cmd: "npx", args, env: { ...env, LUMEN_VISUAL_APPROVE: "1" } };
}

async function main(argv, env) {
  const suite = argv.find((a) => !a.startsWith("-"));
  const yes = argv.includes("--yes");
  const dry = argv.includes("--dry-run");
  if (isGateRun(env)) {
    console.error("visual:approve refuses to run on the gate (CI / LUMEN_CI / LUMEN_GATE): baselines are approved by a person, never by a gate run.");
    return 2;
  }
  const run = approveCommand(suite, env);
  if (!run) {
    console.error(`usage: npm run visual:approve -- <${Object.keys(SUITES).join("|")}> [--yes] [--dry-run]`);
    return 1;
  }
  if (!yes) {
    if (!process.stdin.isTTY) {
      console.error("visual:approve needs --yes (you looked at every new and changed PNG) or a terminal to confirm on.");
      return 1;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`This writes the ${suite} baselines from this run. Type "approve" once you will review every PNG before committing: `);
    rl.close();
    if (answer.trim() !== "approve") {
      console.error("not approved: nothing written.");
      return 1;
    }
  }
  console.log(`$ LUMEN_VISUAL_APPROVE=1 ${run.cmd} ${run.args.join(" ")}`);
  if (dry) return 0;
  const r = spawnSync(run.cmd, run.args, { stdio: "inherit", env: run.env });
  console.log("\nNow look at every new or changed PNG (git status; the HTML report), and commit only the ones you checked.");
  return r.status ?? 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2), process.env).then((code) => process.exit(code));
}
