/**
 * Plan W4.3 step 2 (audit W10.C30): the domain the project never names, in
 * the whole tree — not only in a PR's added lines.
 *
 * The PR gate (`prGate.mjs` → `domainMentions`) checks added lines only, so
 * a mention that is already on a branch (main held three in `public/`) is
 * never caught. `domainInTree` reads every text file of the checkout:
 * index.html, public/, docs/, README and everything else, apart from
 * dependencies, build output and git's own data. `npm run hygiene`
 * (scripts/check-code-hygiene.mjs) fails on any hit, on every branch it runs
 * on, main included.
 *
 * The domain is built from its parts, so it is never written in the
 * repository (the owner's rule).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** The domain the project never names: lumen + .md as a host (not README.md, not lumen.mdx). */
export const TAKEN_DOMAIN = new RegExp(`${["lumen", "md"].join("\\.")}\\b`, "i");

/** Not the project's text: dependencies, build and test output, git's data. */
export const SKIP_DIRS = new Set([".git", "node_modules", "dist", "dist-ssr", "coverage", "playwright-report", "test-results", "target", ".vercel", ".turbo", ".cache", ".svelte-kit"]);

/** Larger files are data (models, archives), not something a person writes a URL into. */
const MAX_BYTES = 16 * 1024 * 1024;

/** Lines of `text` that name the domain → [{ line, text }]. */
export function domainInText(text) {
  const out = [];
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; i++) if (TAKEN_DOMAIN.test(lines[i])) out.push({ line: i + 1, text: lines[i].trim().slice(0, 160) });
  return out;
}

/** Every text file under `root` (relative paths, "/"-separated). */
export function treeFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else if (e.isFile()) {
        out.push(relative(root, p).split("\\").join("/"));
      }
    }
  };
  walk(root);
  return out.sort();
}

/** Every mention of the domain in the tree under `root` → [{ file, line, text }]. */
export function domainInTree(root) {
  const out = [];
  for (const file of treeFiles(root)) {
    const full = join(root, file);
    let buf;
    try {
      if (statSync(full).size > MAX_BYTES) continue;
      buf = readFileSync(full);
    } catch {
      continue;
    }
    // A binary file (a NUL in its first 8 KB) is not text.
    if (buf.subarray(0, 8192).includes(0)) continue;
    for (const hit of domainInText(buf.toString("utf8"))) out.push({ file, ...hit });
  }
  return out;
}
