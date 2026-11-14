/**
 * Every leak the redaction fuzz ever found stays a test (plan W8.8). The
 * nightly fuzz (`npm run fuzz:redaction`) adds each minimised leak to
 * tests/fuzz/redaction/regressions.json; this replays them all with the same
 * oracle: no token the preview shades may survive the export.
 */
import { describe, expect, it } from "vitest";
import corpus from "../../tests/fuzz/redaction/regressions.json";
import { regressionId, type RegressionFile } from "../../tests/fuzz/redaction/campaign";
import { haveDom, leaksOf } from "../../tests/fuzz/redaction/oracle";

const file = corpus as RegressionFile;

describe("redaction fuzz regressions (W8.8)", () => {
  it("each case is named by its note, once", () => {
    const ids = file.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of file.cases) expect(c.id, c.md).toBe(regressionId(c.md));
  });
  (haveDom ? it : it.skip)(`${file.cases.filter((c) => !c.open).length} fixed minimised leaks: none leaks now`, () => {
    const still: string[] = [];
    for (const c of file.cases.filter((x) => !x.open)) {
      const l = leaksOf(c.md);
      if (l.full.length || l.blocks.length) still.push(`${c.id} (${c.found}, ${c.generator}) keeps ${[...l.full, ...l.blocks].join(",")}: ${JSON.stringify(c.md)}`);
    }
    expect(still).toEqual([]);
  });
  (haveDom ? it : it.skip)("open findings still leak (fixing one means removing its `open` field)", () => {
    const fixed = file.cases.filter((c) => c.open && (() => { const l = leaksOf(c.md); return l.full.length + l.blocks.length === 0; })());
    expect(fixed.map((c) => `${c.id} (${c.open}) no longer leaks: remove its "open" field`)).toEqual([]);
  });
});
