// @vitest-environment node
/**
 * Plan W4.17 — the mutation floor in the preview build: the committed
 * receipt must hold a score of at least 80% for every critical module on the
 * branch, measured on its current source.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — plain .mjs script without type declarations
import { checkReceipt, isRealRun, scoreLabel } from "../../scripts/mutation/check.mjs";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const testsHash = (files: Array<[string, string]>) => sha(files.map(([f, text]) => `${f}\0\0${text}`).join("\0"));
const targets = {
  critical: { min: 80, modules: ["a.ts", "b.ts", "c.ts", "d.ts", "gone.ts"] },
  modules: { "a.ts": [{ file: "a.test.ts" }], "b.ts": [{ file: "b.test.ts" }], "c.ts": [{ file: "c.test.ts" }], "d.ts": [] },
};
const files: Record<string, string> = { "a.ts": "A", "b.ts": "B", "c.ts": "C2", "d.ts": "D", "a.test.ts": "ta", "b.test.ts": "tb", "c.test.ts": "tc" };
const read = (p: string) => files[p] ?? null;
/** A full run under real vitest: the only kind the gate counts (W10.B14). */
const full = { runner: "vitest", sampled: 40, mutants: 40 };

describe("mutation receipt check (W4.17)", () => {
  it("passes a current score of at least 80, fails a low, stale or missing one, and skips an absent module", () => {
    const receipt = {
      modules: {
        "a.ts": { ...full, score: 80, sha256: sha("A"), tests: testsHash([["a.test.ts", "ta"]]), date: "2026-11-12" },
        "b.ts": { ...full, score: 79.9, sha256: sha("B"), tests: testsHash([["b.test.ts", "tb"]]), date: "2026-11-12" },
        "c.ts": { ...full, score: 95, sha256: sha("C"), tests: testsHash([["c.test.ts", "tc"]]), date: "2026-11-12" },
      },
    };
    const rows = checkReceipt(targets, receipt, read) as Array<{ module: string; state: string; testsChanged?: boolean }>;
    expect(rows.map((r) => [r.module, r.state])).toEqual([
      ["a.ts", "ok"],
      ["b.ts", "low"],
      ["c.ts", "stale"],
      ["d.ts", "missing"],
      ["gone.ts", "absent"],
    ]);
    expect(rows[0].testsChanged).toBe(false);
  });

  it("notes changed tests without failing on them", () => {
    const receipt = { modules: { "a.ts": { ...full, score: 90, sha256: sha("A"), tests: "old", date: "2026-11-12" } } };
    const [a] = checkReceipt({ ...targets, critical: { min: 80, modules: ["a.ts"] } }, receipt, read) as Array<{ state: string; testsChanged: boolean }>;
    expect(a).toMatchObject({ state: "ok", testsChanged: true });
  });

  it("a shim run or a sample is an estimate and does not pass, whatever its score (W10.B14)", () => {
    const one = (r: Record<string, unknown>) =>
      (checkReceipt({ ...targets, critical: { min: 80, modules: ["a.ts"] } }, { modules: { "a.ts": { sha256: sha("A"), tests: "x", date: "2026-11-14", ...r } } }, read) as Array<{ state: string; note: string }>)[0];
    // argon2 as committed on the train: 90 on 80 of 502 mutants, shim.
    const shimSample = one({ score: 90, runner: "shim", sampled: 80, mutants: 502 });
    expect(shimSample.state).toBe("estimated");
    expect(shimSample.note).toContain("~90% estimated (80/502 mutants, runner shim)");
    // Every mutant, but in the shim: still an estimate.
    expect(one({ score: 100, runner: "shim", sampled: 17, mutants: 17 }).state).toBe("estimated");
    // Real vitest, but a sample: still an estimate.
    expect(one({ score: 95, runner: "vitest", sampled: 120, mutants: 502 }).state).toBe("estimated");
    // No runner recorded: an estimate.
    expect(one({ score: 95, sampled: 10, mutants: 10 }).state).toBe("estimated");
    // A low estimate says so.
    expect(one({ score: 58.3, runner: "shim", sampled: 80, mutants: 300 }).note).toContain("under 80% even as an estimate");
    // Only vitest over every mutant is a score.
    expect(one({ score: 90, runner: "vitest", sampled: 502, mutants: 502 })).toMatchObject({ state: "ok", note: "90% (502/502 mutants, vitest)" });
    expect(one({ score: 79, runner: "vitest", sampled: 502, mutants: 502 }).state).toBe("low");
  });

  it("isRealRun and scoreLabel", () => {
    expect(isRealRun({ runner: "vitest", sampled: 5, mutants: 5 })).toBe(true);
    expect(isRealRun({ runner: "vitest", sampled: 0, mutants: 0 })).toBe(false);
    expect(isRealRun({ runner: "shim", sampled: 5, mutants: 5 })).toBe(false);
    expect(scoreLabel({ score: 90, runner: "shim", sampled: 80, mutants: 502 })).toBe("~90% estimated (80/502 mutants, runner shim)");
  });

  it("the committed receipt covers every critical module on its current source; shim samples count only as estimates", () => {
    const root = join(__dirname, "..", "..");
    const real = JSON.parse(readFileSync(join(root, "scripts/mutation/targets.json"), "utf8"));
    const receipt = JSON.parse(readFileSync(join(root, "scripts/mutation/receipt.json"), "utf8"));
    const rows = checkReceipt(real, receipt, (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null)) as Array<{ module: string; state: string }>;
    // Every critical module has an entry measured on its current source.
    expect(rows.filter((r) => r.state === "missing" || r.state === "stale")).toEqual([]);
    // An entry counts as passing only when it is a full vitest run.
    for (const r of rows) {
      if (r.state === "ok") expect(isRealRun(receipt.modules[r.module]), r.module).toBe(true);
      else if (r.state !== "absent") expect(r.state, r.module).toMatch(/^(estimated|low)$/);
    }
    expect(real.critical.min).toBe(80);
  });

  it("npm run test:mutation fails under 80, as the task says (not 70)", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["test:mutation"]).toMatch(/--min 80\b/);
  });
});
