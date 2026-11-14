#!/usr/bin/env node
/**
 * The train's offline gate (plan W6.4, W10.D6): every crypto attack test in
 * security/attacks must pass. Each test asserts the secure outcome, so a
 * failure means an attack worked.
 *
 *   node scripts/train-offline.mjs                 vitest run security/attacks
 *   node scripts/train-offline.mjs --runner <cmd>  <cmd> <worktree> <file> per file
 *                                                  (an offline runner such as the
 *                                                  shim; its last line must be
 *                                                  "… pass N fail 0")
 *   node scripts/train-offline.mjs --list          the files, one per line
 *
 * Exit 1 when any attack test fails, or when there is none to run.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ATTACK_DIR = "security/attacks";

/** The attack test files, relative to `root`, sorted. */
export function attackFiles(root = process.cwd()) {
  return readdirSync(join(root, ATTACK_DIR))
    .filter((f) => f.endsWith(".test.ts"))
    .sort()
    .map((f) => `${ATTACK_DIR}/${f}`);
}

/** Pass/fail counts from a runner's last "pass N fail M" line, or null. */
export function parseCounts(out) {
  const lines = String(out).trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /pass (\d+) fail (\d+)/.exec(lines[i]);
    if (m) return { pass: Number(m[1]), fail: Number(m[2]) };
  }
  return null;
}

/** Whether one file's run is green: at least one test passed and none failed. */
export function green(counts) {
  return !!counts && counts.pass > 0 && counts.fail === 0;
}

function main(argv) {
  const root = process.cwd();
  const files = attackFiles(root);
  if (argv.includes("--list")) {
    console.log(files.join("\n"));
    return 0;
  }
  if (files.length === 0) {
    console.error(`✗ train-offline: no attack tests in ${ATTACK_DIR}`);
    return 1;
  }
  const i = argv.indexOf("--runner");
  if (i < 0) {
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    const r = spawnSync(npx, ["vitest", "run", ATTACK_DIR], { stdio: "inherit" });
    return r.status ?? 1;
  }
  const runner = argv[i + 1];
  let bad = 0;
  for (const f of files) {
    const r = spawnSync(runner, [root, f], { encoding: "utf8" });
    const c = parseCounts(`${r.stdout}\n${r.stderr}`);
    const ok = green(c);
    if (!ok) bad++;
    console.log(`${ok ? "✓" : "✗"} ${f}: ${c ? `pass ${c.pass} fail ${c.fail}` : "no result"}`);
  }
  console.log(`train-offline: ${files.length - bad}/${files.length} attack files green`);
  return bad ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
