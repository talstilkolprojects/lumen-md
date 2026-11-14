/**
 * Setup for every live eval (vitest.eval.config.ts, plan W7.15): Ollama
 * 0.34+ speculates by default, and its output is then not always the same
 * at temperature 0. The eval pins `draft_num_predict: 0` on every request
 * (the Ollama executor reads REPRODUCIBLE_KEY) and records the Ollama
 * version next to the results, so a score can be reproduced.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPRODUCIBLE_KEY } from "../../ai/speculative";

localStorage.setItem(REPRODUCIBLE_KEY, "1");
process.env.LUMEN_OLLAMA_REPRODUCIBLE = "1";

const url = process.env.LUMEN_EVAL_OLLAMA_URL || "http://localhost:11434";
const outDir = process.env.LUMEN_EVAL_OUT || "eval/results";
try {
  const r = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(2000) });
  const v = r.ok ? ((await r.json()) as { version?: string }).version : undefined;
  if (v) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "ollama-run.json"), JSON.stringify({ ollama: v, url, draft_num_predict: 0, at: new Date().toISOString() }, null, 2) + "\n");
  }
} catch {
  /* no Ollama: the evals that need it say so themselves */
}
