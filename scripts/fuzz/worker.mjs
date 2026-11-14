/**
 * One fuzz target in a worker thread (scripts/fuzz/run.mjs). Publishes the
 * index it is working on in shared memory, so the main thread can stop it
 * when one input runs longer than the limit, and reports crashes and the
 * slowest call.
 */
import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const { root, name, seed, from, to, slowMs, progress } = workerData;
const cur = new Int32Array(progress);
const { TARGETS } = await import(pathToFileURL(join(root, "scripts/fuzz/targets.mjs")).href);
const { generate } = await import(pathToFileURL(join(root, "scripts/fuzz/generators.ts")).href);
const target = TARGETS.find((t) => t.name === name);

let fn;
try {
  fn = await target.load(root);
} catch (e) {
  parentPort.postMessage({ type: "unavailable", error: String(e?.message ?? e).split("\n")[0] });
  process.exit(0);
}

const crashes = [];
const slow = [];
let maxMs = 0;
let ran = 0;
for (let i = from; i < to; i++) {
  Atomics.store(cur, 0, i);
  const input = generate(target.gen, seed, i);
  const t0 = performance.now();
  try {
    fn(input);
  } catch (e) {
    if (!target.expected?.(e)) {
      if (crashes.length < 20) crashes.push({ index: i, error: `${e?.name ?? "Error"}: ${String(e?.message ?? e).split("\n")[0].slice(0, 300)}` });
      else crashes.push({ index: i });
    }
  }
  const ms = performance.now() - t0;
  if (ms > maxMs) maxMs = ms;
  if (ms >= slowMs && slow.length < 20) slow.push({ index: i, ms: Math.round(ms) });
  ran++;
  if ((i & 1023) === 0) parentPort.postMessage({ type: "tick", index: i });
}
Atomics.store(cur, 1, 1);
parentPort.postMessage({ type: "done", ran, crashes, slow, maxMs });
