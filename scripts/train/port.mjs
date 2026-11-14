#!/usr/bin/env node
/**
 * Port theirs' change (base → theirs) of one conflicted file onto ours
 * (plan W6.42, promoted from lanes T/T2), even when ours moved the code to
 * another file, as when src/commands/useCommands.ts split into
 * src/commands/domains/*. Each diff hunk is located by its old lines
 * (trimmed, one unique match), first in ours' version of the file, then
 * anywhere under src/.
 *
 *   node scripts/train/port.mjs <conflicted file>
 *
 * Exit 0 when every hunk applied (files written, the conflicted file set to
 * the result and staged), 1 when something is left (nothing written).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseUnified, portHunks } from "./lib.mjs";

/** base → theirs as a -U3 diff. */
export function unifiedDiff(base, theirs) {
  const dir = mkdtempSync(join(tmpdir(), "lumen-port-"));
  try {
    writeFileSync(join(dir, "b"), base);
    writeFileSync(join(dir, "t"), theirs);
    try {
      return execFileSync("git", ["diff", "--no-index", "--no-color", "-U3", join(dir, "b"), join(dir, "t")], { encoding: "utf8", maxBuffer: 1 << 28 });
    } catch (e) {
      return e.stdout; // why: git diff --no-index exits 1 when the files differ
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Source files under `dir` (relative to cwd), node_modules skipped. */
function walk(cwd, dir, out = []) {
  let names = [];
  try {
    names = readdirSync(join(cwd, dir));
  } catch {
    return out; // why: no such directory in this checkout
  }
  for (const n of names) {
    const rel = join(dir, n);
    if (statSync(join(cwd, rel)).isDirectory()) {
      if (n !== "node_modules") walk(cwd, rel, out);
    } else if (/\.(tsx?|mjs|js|css|json|md)$/.test(n)) out.push(rel);
  }
  return out;
}

/**
 * Port `file`'s theirs onto ours in `cwd`. Writes (and, unless
 * `stage: false`, stages) only when every hunk applied.
 * → { left: [reasons], moved: [files], touched: [files] }.
 */
export function portFile(cwd, file, { base, ours, theirs }, { stage = true } = {}) {
  const hunks = parseUnified(unifiedDiff(base, theirs));
  const r = portHunks(file, hunks, new Map([[file, ours]]), walk(cwd, "src"), (f) => {
    try {
      return readFileSync(join(cwd, f), "utf8");
    } catch {
      return null; // why: a candidate that vanished; skip it
    }
  });
  if (r.left.length) return { left: r.left, moved: [], touched: [] };
  const touched = [];
  for (const [f, text] of r.texts) {
    if (f !== file && readFileSync(join(cwd, f), "utf8") === text) continue;
    writeFileSync(join(cwd, f), text);
    if (stage) execFileSync("git", ["add", "--", f], { cwd });
    touched.push(f);
  }
  return { left: [], moved: [...new Set(r.moved.map((m) => m.to))], touched };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const file = process.argv[2];
  const show = (n) => {
    try {
      return execFileSync("git", ["show", `:${n}:${file}`], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return null; // why: the stage is missing (one side deleted or added the file)
    }
  };
  const base = show(1);
  const ours = show(2);
  const theirs = show(3);
  if (!file || base === null || ours === null || theirs === null) {
    console.log(`port: ${file ?? "(no file)"} is missing a stage`);
    process.exit(1);
  }
  const r = portFile(process.cwd(), file, { base, ours, theirs });
  if (r.left.length) {
    console.log(`port: ${file}: ${r.left.join("; ")}`);
    process.exit(1);
  }
  console.log(`port: ${file} applied${r.moved.length ? ` (→ ${r.moved.join(", ")})` : ""}`);
}
