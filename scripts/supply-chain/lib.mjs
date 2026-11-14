/** Shared by the supply-chain scripts (plan W1.27). */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Every file under `dir`, as forward-slash paths relative to it, sorted. */
export function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const sha256File = (path) => sha256(readFileSync(path));

/** `sha256sum` format: "<hex>  <path>" per line, sorted by path. */
export function checksums(entries) {
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((e) => `${e.hash}  ${e.path}`).join("\n") + "\n";
}

export function parseChecksums(text) {
  return String(text)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(l);
      if (!m) throw new Error(`Not a checksum line: ${l}`);
      return { hash: m[1], path: m[2] };
    });
}

export const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

export function opts(argv) {
  const args = argv.slice(2);
  return {
    args,
    get: (n, d) => (args.includes(n) && args.indexOf(n) + 1 < args.length ? args[args.indexOf(n) + 1] : d),
    has: (n) => args.includes(n),
  };
}
