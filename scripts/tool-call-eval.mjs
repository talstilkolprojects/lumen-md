#!/usr/bin/env node
// Plan W4.31: tool-call reliability of local models (src/agents/eval/toolCalls.eval.ts).
//
//   npm run eval:tool-calls -- [--models qwen2.5:7b,gemma3:12b] [--url http://localhost:11434] [--out eval/results]
//
// 200 Hebrew and English probes per model through the agent runtime; the
// target is >= 95 % valid calls on both models. Needs the models pulled.
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const env = { ...process.env, LUMEN_EVAL_TOOLCALLS: "1" };
for (let i = 0; i < args.length; i++) {
  const [flag, inline] = args[i].split("=");
  const value = inline ?? args[++i];
  if (flag === "--models") env.LUMEN_EVAL_MODELS = value;
  else if (flag === "--url") env.LUMEN_EVAL_OLLAMA_URL = value;
  else if (flag === "--out") env.LUMEN_EVAL_OUT = value;
  else {
    console.error(`unknown option ${flag}\nusage: npm run eval:tool-calls -- [--models a,b] [--url u] [--out dir]`);
    process.exit(2);
  }
}
const r = spawnSync("npx", ["vitest", "run", "--config", "vitest.eval.config.ts", "src/agents/eval/toolCalls.eval.ts"], { stdio: "inherit", env, shell: process.platform === "win32" });
process.exit(r.status ?? 1);
