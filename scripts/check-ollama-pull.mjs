#!/usr/bin/env node
// Plan 5.7: the model manager's Ollama pull, end to end over real HTTP —
// the app's own client (src/ai/ollamaPull.ts) against an Ollama server
// (scripts/fake-ollama.mjs in CI; a real one works too, but downloads).
//
//   node --experimental-strip-types scripts/check-ollama-pull.mjs [--url http://localhost:11434] [--model qwen3:4b]
//
// Checks: bytes done only go up and progress ends at 100 %, the model is listed by
// /api/tags afterwards, an unknown model fails with Ollama's error, and
// the model can be deleted again (so later steps see the original list).
const args = process.argv.slice(2);
const opt = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
};
const base = opt("--url", process.env.LUMEN_EVAL_OLLAMA_URL || "http://localhost:11434");
const model = opt("--model", "qwen3:4b");
const { pullOllamaModel, deleteOllamaModel } = await import(new URL("../src/ai/ollamaPull.ts", import.meta.url).href);

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
const tags = async () => ((await (await fetch(`${base}/api/tags`)).json()).models ?? []).map((m) => m.name);

const before = await tags();
const seen = [];
await pullOllamaModel(base, model, { onProgress: (p) => seen.push(p) });
const sized = seen.filter((p) => p.fraction !== null);
const fractions = sized.map((p) => p.fraction);
if (!fractions.length) fail("no progress was reported");
// Ollama names a layer only when it starts, so the total grows and the
// fraction may dip then; bytes done never go back, nor the fraction while
// the total stays the same.
for (let i = 1; i < sized.length; i++) {
  const [a, b] = [sized[i - 1], sized[i]];
  if (b.completed < a.completed || (b.total === a.total && b.fraction < a.fraction)) fail(`progress went back: ${fractions.join(", ")}`);
}
if (fractions.at(-1) !== 1) fail(`progress ended at ${fractions.at(-1)}`);
if (seen.at(-1)?.status !== "success") fail(`last status was "${seen.at(-1)?.status}"`);
if (!(await tags()).includes(model)) fail(`${model} is not listed after the pull`);
console.log(`✓ pulled ${model}: ${seen.length} records, ${fractions.length} with progress, ended at 100 %`);

let failed = null;
try {
  await pullOllamaModel(base, "missing-model:1b");
} catch (e) {
  failed = e;
}
if (!failed || !/file does not exist|not found/i.test(String(failed.message))) fail(`an unknown model did not fail with Ollama's error (${failed?.message ?? "it succeeded"})`);
console.log(`✓ unknown model → ${failed.message}`);

if (!before.includes(model)) {
  await deleteOllamaModel(base, model);
  if ((await tags()).includes(model)) fail(`${model} is still listed after the delete`);
  console.log(`✓ deleted ${model} again`);
}
