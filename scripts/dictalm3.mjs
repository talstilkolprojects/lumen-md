#!/usr/bin/env node
/**
 * DictaLM 3.0 in the Hebrew model catalogue (plan W2.4).
 *
 *   npm run dictalm3                    # status: each size, its licence and open owner checks
 *   npm run dictalm3 -- eval --size 1.7B [--url http://localhost:11434]
 *        runs `npm run eval:agents` (agent eval + Hebrew prompt eval) on the
 *        variant and on the model it is compared with → eval/results/
 *   npm run dictalm3 -- decide [--json eval/results/dictalm3-decision.json]
 *        reads eval/results and prints, per size: blocked / no-results /
 *        keep / offer / switch, and the catalog line to add when there is one
 *
 * models/dictalm3.json holds the variants. Nothing is evaluated or proposed
 * while a variant has an open owner check (an unverified repo, revision or
 * licence). The default only changes on a gain of at least `minGainPoints`.
 * Rules: scripts/lib/dictalm3.mjs. Exit 1 on an invalid manifest or an
 * unknown command; `eval` exits 1 when the variant is blocked.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogLine, decide, openChecks, validateManifest } from "./lib/dictalm3.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = resolve(flag("--root") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const manifestPath = join(root, "models", "dictalm3.json");
const resultsDir = resolve(root, flag("--results") ?? "eval/results");
const cmd = args[0] && !args[0].startsWith("--") ? args[0] : "status";

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const problems = validateManifest(manifest);
if (problems.length) {
  console.error(`✗ models/dictalm3.json is invalid:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

function readResults() {
  if (!existsSync(resultsDir)) return [];
  return readdirSync(resultsDir)
    .filter((n) => n.endsWith(".json"))
    .map((name) => {
      try {
        return { name, json: JSON.parse(readFileSync(join(resultsDir, name), "utf8")) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

if (cmd === "status") {
  console.log(`DictaLM 3.0 — ${manifest.variants.length} sizes (${manifest.paper})\n`);
  for (const v of manifest.variants) {
    const open = openChecks(v);
    console.log(`${v.size.padEnd(5)} base ${v.base}`);
    console.log(`      repo     ${v.repo ?? "— (owner check)"}${v.revision ? ` @ ${v.revision.slice(0, 12)}` : ""}`);
    console.log(`      ollama   ${v.ollama ?? "— (owner check)"}${v.ollamaRevision ? ` @ ${v.ollamaRevision.slice(0, 12)}` : ""}`);
    console.log(`      licence  ${v.licence.name ?? "unknown"} · ${v.licence.class}${v.licence.verified ? " · verified" : " · NOT verified"}`);
    console.log(`      compare  ${v.compareWith} (≥ ${manifest.minGainPoints} points to become the default)`);
    console.log(open.length ? `      ⏳ open: ${open.join(", ")}` : "      ✓ ready to evaluate");
    for (const c of open.length ? v.ownerChecks : []) console.log(`        - ${c}`);
    console.log("");
  }
  process.exit(0);
}

if (cmd === "eval") {
  const size = flag("--size");
  const v = manifest.variants.find((x) => x.size.toLowerCase() === String(size).toLowerCase());
  if (!v) {
    console.error(`usage: npm run dictalm3 -- eval --size <${manifest.variants.map((x) => x.size).join("|")}> [--url u]`);
    process.exit(1);
  }
  const open = openChecks(v);
  if (open.length) {
    console.error(`✗ DictaLM 3.0 ${v.size} is blocked — owner checks open: ${open.join(", ")}\n  ${v.ownerChecks.join("\n  ")}\n  Fill them in models/dictalm3.json first.`);
    process.exit(1);
  }
  mkdirSync(resultsDir, { recursive: true });
  for (const model of [v.ollama, v.compareWith]) {
    const pass = ["run", "eval:agents", "--", "--model", model, "--out", resultsDir, ...(flag("--url") ? ["--url", flag("--url")] : [])];
    console.log(`\n▶ npm ${pass.join(" ")}`);
    const r = spawnSync("npm", pass, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
    if (r.status !== 0) console.error(`(eval of ${model} exited ${r.status}; failed cases still count in its results)`);
  }
  console.log(`\nNext: npm run dictalm3 -- decide`);
  process.exit(0);
}

if (cmd === "decide") {
  const files = readResults();
  const out = [];
  for (const v of manifest.variants) {
    const d = decide(v, files, manifest.minGainPoints);
    const line = catalogLine(v, d);
    out.push({ ...d, catalogLine: line });
    console.log(`${v.size.padEnd(5)} ${d.verdict.toUpperCase().padEnd(10)} ${d.reason}`);
    if (line) console.log(`      src/ai/modelCatalog.ts OLLAMA_CATALOG:\n${line}`);
  }
  const jsonOut = flag("--json");
  if (jsonOut) {
    const p = resolve(root, jsonOut);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ date: new Date().toISOString().slice(0, 10), minGainPoints: manifest.minGainPoints, decisions: out }, null, 2) + "\n");
    console.log(`\nwritten: ${jsonOut}`);
  }
  process.exit(0);
}

console.error(`unknown command "${cmd}" — status | eval --size <size> | decide [--json file]`);
process.exit(1);
