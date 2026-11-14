#!/usr/bin/env node
// Plan 6.9 / owner item 15.17 — latency of local autocomplete (FIM) on a real
// Ollama: the same request the editor sends (src/ai/fimCore.ts), over a fixed
// set of English, Hebrew and code contexts, after a warm-up.
//
//   npm run bench:fim -- [--url http://localhost:11434] [--model qwen2.5-coder:1.5b]
//                        [--rounds 3] [--assert 300] [--json out.json]
//
// Prints p50 / p95 (ms). `--assert N` exits 1 when p50 ≥ N ms (the plan's
// target is p50 < 300 ms). Needs a running Ollama with a qwen2.5-coder model;
// it never contacts anything else.
import { writeFileSync } from "node:fs";
import { fimRequestBody, cleanFim, percentile, pickFimModel } from "../src/ai/fimCore.ts";

const args = process.argv.slice(2);
const opt = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
};
const url = opt("--url", process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/+$/, "");
const rounds = Number(opt("--rounds", "3"));
const assertMs = opt("--assert", null);
const jsonOut = opt("--json", null);

const CASES = [
  ["The meeting moved to Thursday because ", " Everyone agreed."],
  ["To install the app, open a terminal and ", "\n\n## Next steps"],
  ["Our goal for the quarter is to ", " by the end of March."],
  ["Dear Dana,\n\nThank you for ", "\n\nBest regards,\nTal"],
  ["The results show that the new method ", " compared with the baseline."],
  ["הפגישה נדחתה ליום חמישי כי ", " כולם הסכימו."],
  ["כדי להתקין את האפליקציה, פותחים מסוף ו", "\n\n## השלבים הבאים"],
  ["המטרה שלנו לרבעון היא ", " עד סוף מרץ."],
  ["שלום דנה,\n\nתודה על ", "\n\nבברכה,\nטל"],
  ["התוצאות מראות שהשיטה החדשה ", " בהשוואה לשיטה הקודמת."],
  ["function add(a: number, b: number): number {\n  ", "\n}\n"],
  ["const users = await db.query(", ");\nreturn users;"],
  ["def fib(n):\n    if n < 2:\n        return n\n    ", "\n"],
  ["```ts\nexport function slugify(s: string) {\n  return s.", "\n}\n```"],
  ["| Name | Role |\n|---|---|\n| Dana | ", " |\n| Tal | Owner |"],
  ["- [ ] Write the report\n- [ ] ", "\n- [ ] Send it to the team"],
  ["# Weekly notes\n\n## Monday\n\n", "\n\n## Tuesday"],
  ["SELECT name, email FROM users WHERE ", " ORDER BY name;"],
  ["The capital of France is ", ", which is known for the Eiffel Tower."],
  ["[[Project plan]] lists three risks: ", "."],
];

async function json(path, init) {
  const res = await fetch(`${url}${path}`, init);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

let model = opt("--model", null);
try {
  const tags = await json("/api/tags");
  const installed = (tags.models ?? []).map((m) => m.name);
  model = model ?? pickFimModel(installed);
  if (!model) {
    console.error(`No FIM model on ${url}. Install one: ollama pull qwen2.5-coder:1.5b`);
    process.exit(2);
  }
} catch (e) {
  console.error(`Ollama is not reachable at ${url} (${e.message}).`);
  process.exit(2);
}

const generate = async ([prefix, suffix]) => {
  const t0 = performance.now();
  const data = await json("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fimRequestBody(model, prefix, suffix)) });
  return { ms: performance.now() - t0, text: cleanFim(data.response ?? "", suffix) };
};

// Warm-up: load the model (a cold load is seconds and is not what typing feels).
await generate(CASES[0]);
await generate(CASES[5]);

const times = [];
let empty = 0;
for (let r = 0; r < rounds; r++) {
  for (const c of CASES) {
    const { ms, text } = await generate(c);
    times.push(ms);
    if (!text.trim()) empty++;
  }
}
const p50 = percentile(times, 50);
const p95 = percentile(times, 95);
const out = { model, url, requests: times.length, p50Ms: Math.round(p50), p95Ms: Math.round(p95), emptyCompletions: empty };
console.log(`FIM on ${model} (${url}): ${times.length} requests — p50 ${out.p50Ms} ms, p95 ${out.p95Ms} ms, empty ${empty}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 2) + "\n");
if (assertMs !== null && p50 >= Number(assertMs)) {
  console.error(`p50 ${out.p50Ms} ms is not under ${assertMs} ms`);
  process.exit(1);
}
