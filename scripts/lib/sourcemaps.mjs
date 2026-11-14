/**
 * Source maps in a build folder (plan 11.5): `.map` files, and
 * `sourceMappingURL` comments in .js / .css / .html / .mjs files.
 * Returns the paths (relative to `dir`) that have one.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const COMMENT = /[#@]\s*sourceMappingURL=/;
const TEXT = /\.(?:m?js|css|html)$/;

export async function findSourceMaps(dir) {
  const out = [];
  async function walk(d) {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".map")) out.push(path.relative(dir, p));
      else if (TEXT.test(e.name)) {
        const text = await fs.readFile(p, "utf8");
        if (COMMENT.test(text.slice(-4096)) || COMMENT.test(text.slice(0, 4096))) out.push(path.relative(dir, p));
      }
    }
  }
  await walk(dir);
  return out.sort();
}
