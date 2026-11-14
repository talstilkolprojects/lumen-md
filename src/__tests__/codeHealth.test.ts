/**
 * 12.1 — code health without a baseline:
 *  - every swallowed error says why: an empty `catch` block, or an empty
 *    function passed to `.catch(…)`, holds a `why:` comment (the same check
 *    as the `lumen/empty-catch-why` ESLint rule, so it also runs without ESLint);
 *  - no production file is longer than 800 lines (ESLint `max-lines`) —
 *    pending: the splits of 12.1 are not done on the integrated code yet, so
 *    this is a todo until they are (the 16 files over 800 lines are listed in
 *    the 12.1 status);
 *  - eslint-suppressions.json records neither rule, so neither can be baselined.
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..");
const MAX_LINES = 800;
const WHY = /^\s*why:\s*\S/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "node_modules" ? [] : files(p);
    return /\.(ts|tsx)$/.test(f) && !f.endsWith(".d.ts") ? [p] : [];
  });
}

/** Comment texts between two offsets, with leading spaces and stars removed. */
function commentsBetween(text: string, start: number, end: number): string[] {
  const out: string[] = [];
  const re = /\/\/([^\n]*)|\/\*([\s\S]*?)\*\//g;
  const inner = text.slice(start, end);
  for (let m = re.exec(inner); m; m = re.exec(inner)) out.push((m[1] ?? m[2]).replace(/^[\s*]+/, ""));
  return out;
}

function swallowedWithoutWhy(): string[] {
  const out: string[] = [];
  for (const file of files(SRC)) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("catch")) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const where = (n: ts.Node) => `${relative(SRC, file)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
    const empty = (b: ts.Block) => b.statements.length === 0 && !commentsBetween(text, b.getStart(sf) + 1, b.end - 1).some((c) => WHY.test(c));
    const visit = (n: ts.Node): void => {
      if (ts.isCatchClause(n) && empty(n.block)) out.push(`${where(n)} catch`);
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "catch") {
        const h = n.arguments[0];
        if (h && (ts.isArrowFunction(h) || ts.isFunctionExpression(h)) && ts.isBlock(h.body) && empty(h.body)) out.push(`${where(h)} .catch()`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

describe("code health (12.1)", () => {
  it("every empty catch and empty .catch() handler says why", () => {
    expect(swallowedWithoutWhy()).toEqual([]);
  });

  it.todo(`no production file is longer than ${MAX_LINES} lines (12.1 splits)`);

  it("the ESLint baseline records neither rule", () => {
    const suppressions = JSON.parse(readFileSync(join(SRC, "..", "eslint-suppressions.json"), "utf8")) as Record<string, Record<string, unknown>>;
    const baselined = Object.entries(suppressions).flatMap(([f, rules]) =>
      Object.keys(rules)
        .filter((r) => r === "lumen/empty-catch-why" || r === "max-lines")
        .map((r) => `${f} ${r}`),
    );
    expect(baselined).toEqual([]);
  });
});
