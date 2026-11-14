#!/usr/bin/env node
// Plan W2.18: the canvas "draw me" eval on a local model (src/agents/eval/canvasDraw.eval.ts).
//
//   npm run eval:canvas-draw -- --model qwen2.5:7b [--url http://localhost:11434] [--out eval/results]
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const env = { ...process.env, LUMEN_EVAL_CANVAS: "1" };
for (let i = 0; i < args.length; i++) {
  const [flag, inline] = args[i].split("=");
  const value = inline ?? args[++i];
  if (flag === "--model") env.LUMEN_EVAL_MODEL = value;
  else if (flag === "--url") env.LUMEN_EVAL_OLLAMA_URL = value;
  else if (flag === "--out") env.LUMEN_EVAL_OUT = value;
  else {
    console.error(`unknown option ${flag}\nusage: npm run eval:canvas-draw -- [--model m] [--url u] [--out dir]`);
    process.exit(2);
  }
}
const r = spawnSync("npx", ["vitest", "run", "--config", "vitest.eval.config.ts", "--reporter", "verbose", "src/agents/eval/canvasDraw.eval.ts"], { stdio: "inherit", env, shell: process.platform === "win32" });
process.exit(r.status ?? 1);
