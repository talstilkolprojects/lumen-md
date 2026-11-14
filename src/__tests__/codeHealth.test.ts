/**
 * 12.1 — code health without a baseline:
 *  - every swallowed error says why: an empty `catch` block, or an empty
 *    function passed to `.catch(…)`, holds a `why:` comment (the same check
 *    as the `lumen/empty-catch-why` ESLint rule, so it also runs without ESLint);
 *  - no production file is longer than 800 lines (as ESLint `max-lines`
 *    counts) — W6.25: the files that already were are grandfathered in
 *    scripts/max-lines-baseline.json with their count, may not grow, and the
 *    baseline only goes down (scripts/lib/maxLines.mjs; pr:check fails a diff
 *    that raises it);
 *  - eslint-suppressions.json records neither rule, so neither can be baselined.
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
// @ts-expect-error — plain .mjs module without type declarations
import { BASELINE_PATH, baselineRaises, checkMaxLines, countLines, describeProblems, productionLineCounts, shrinkBaseline } from "../../scripts/lib/maxLines.mjs";

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

  describe(`no production file is longer than ${MAX_LINES} lines (W6.25 ratchet)`, () => {
    type Baseline = { max: number; files: Record<string, number> };
    const ROOT = join(SRC, "..");
    const baseline = JSON.parse(readFileSync(join(ROOT, BASELINE_PATH), "utf8")) as Baseline;

    it("no new file passes 800 lines and no grandfathered file grew past its baseline", () => {
      const r = checkMaxLines(productionLineCounts(ROOT), baseline);
      expect(describeProblems({ ...r, shrunk: [], invalid: [] })).toEqual([]);
    });

    it("the baseline is exact: every entry is a file still over 800 at its current count (lower it with --shrink)", () => {
      expect(baseline.max).toBe(MAX_LINES);
      const r = checkMaxLines(productionLineCounts(ROOT), baseline);
      expect(describeProblems({ ...r, grown: [], tooLong: [] })).toEqual([]);
    });

    it("the baseline only goes down: a shrink lowers and drops entries, never raises or adds one", () => {
      const before = { max: 800, files: { "src/a.ts": 900, "src/b.ts": 850, "src/c.ts": 1000, "src/gone.ts": 810 } };
      const counts = { "src/a.ts": 880, "src/b.ts": 790, "src/c.ts": 1200, "src/new.ts": 2000 };
      const after = shrinkBaseline(before, counts);
      expect(after.files).toEqual({ "src/a.ts": 880, "src/c.ts": 1000 });
      expect(baselineRaises(before, after)).toEqual([]);
      // The grown file and the new one still fail after the shrink.
      const r = checkMaxLines(counts, after);
      expect(r.grown).toEqual([{ file: "src/c.ts", lines: 1200, baseline: 1000 }]);
      expect(r.tooLong).toEqual([{ file: "src/new.ts", lines: 2000 }]);
      // Editing the baseline upwards is caught (pr:check runs this against the merge base).
      const edited = { max: 800, files: { ...after.files, "src/c.ts": 1200, "src/new.ts": 2000 } };
      expect(baselineRaises(after, edited)).toEqual([
        { file: "src/c.ts", before: 1000, after: 1200 },
        { file: "src/new.ts", before: null, after: 2000 },
      ]);
      // A stale entry fails until it is lowered; one at or under 800 is invalid.
      expect(checkMaxLines({ "src/a.ts": 850 }, { files: { "src/a.ts": 880, "src/x.ts": 800 } })).toMatchObject({
        shrunk: [{ file: "src/a.ts", lines: 850, baseline: 880 }, { file: "src/x.ts", lines: null, baseline: 800 }],
        invalid: [{ file: "src/x.ts", baseline: 800 }],
      });
    });

    it("counts lines as ESLint max-lines does", () => {
      expect([countLines(""), countLines("a"), countLines("a\n"), countLines("a\nb"), countLines("a\r\nb\n\n"), countLines("\n")]).toEqual([0, 1, 1, 2, 3, 1]);
    });
  });

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
