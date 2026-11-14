/**
 * The TypeScript parser for the train's syntax checks: the repo's own
 * (node_modules/typescript), else LUMEN_TS (a path to typescript.js), else
 * the offline copy in an agent sandbox. null when none loads: the
 * resolver then leaves code unions to a person.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);

export function loadTs(env = process.env, cwd = process.cwd()) {
  const tries = [join(cwd, "node_modules", "typescript"), env.LUMEN_TS, "/opt/node-tools/node_modules/typescript"].filter(Boolean);
  for (const p of tries) {
    if (!existsSync(p)) continue;
    try {
      return require(p);
    } catch {
      // why: a broken or partial install; try the next one
    }
  }
  return null;
}

const kindOf = (ts, file) => (file.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.m?ts$/.test(file) ? ts.ScriptKind.TS : file.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.JS);

export const isCode = (file) => /\.(m?ts|tsx|m?js|jsx)$/.test(file);

/** Parse errors of `text` as `file`: ["file:line message", …] (at most 3). */
export function syntaxErrors(ts, file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kindOf(ts, file));
  return (sf.parseDiagnostics || []).slice(0, 3).map((d) => `${file}:${sf.getLineAndCharacterOfPosition(d.start).line + 1} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
}

/** The 0-based line of the first parse error, or -1. */
export function firstErrorLine(ts, file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kindOf(ts, file));
  const d = sf.parseDiagnostics || [];
  return d.length ? sf.getLineAndCharacterOfPosition(d[0].start).line : -1;
}
