#!/usr/bin/env node
// Run the agent eval against a local Ollama and write a report.
//
//   npm run eval:agents -- --model qwen2.5:7b --url http://localhost:11434 --only tagger-he,tasker
//
// See src/agents/eval/live.eval.ts for what is measured.
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const env = { ...process.env };
for (let i = 0; i < args.length; i++) {
  const [flag, inline] = args[i].split("=");
  const value = inline ?? args[++i];
  if (flag === "--model") env.LUMEN_EVAL_MODEL = value;
  else if (flag === "--url") env.LUMEN_EVAL_OLLAMA_URL = value;
  else if (flag === "--only") env.LUMEN_EVAL_ONLY = value;
  else if (flag === "--out") env.LUMEN_EVAL_OUT = value;
  else {
    console.error(`unknown option ${flag}\nusage: npm run eval:agents -- [--model m] [--url u] [--only ids] [--out dir]`);
    process.exit(2);
  }
}
const r = spawnSync("npx", ["vitest", "run", "--config", "vitest.eval.config.ts", "--reporter", "verbose"], { stdio: "inherit", env, shell: process.platform === "win32" });
process.exit(r.status ?? 1);
