/**
 * Drop the `sourceMappingURL` comments from vendor files copied into
 * public/ (plan 11.5: no source maps in what ships). The vendors' own .js
 * files point at .map files that are not copied; the comment alone makes
 * the browser's devtools fetch a 404, and the bundle budget refuses it.
 * Only whole comments are removed (`//# …` on its own line, `/*# … *\/`);
 * the code is not touched. Returns the files changed, relative to `dir`.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const LINE = /^[ \t]*\/\/[#@][ \t]*sourceMappingURL=[^\r\n]*\r?\n?/gm;
const BLOCK = /\/\*[#@][ \t]*sourceMappingURL=[^*]*\*\//g;
const TEXT = /\.(?:m?js|css)$/;

export function stripSourceMapComments(dir) {
  const changed = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (TEXT.test(e.name)) {
        const text = readFileSync(p, "utf8");
        const next = text.replace(LINE, "").replace(BLOCK, "");
        if (next !== text) {
          writeFileSync(p, next);
          changed.push(relative(dir, p));
        }
      }
    }
  };
  walk(dir);
  return changed;
}
