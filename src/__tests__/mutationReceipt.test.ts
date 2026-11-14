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
import { checkReceipt } from "../../scripts/mutation/check.mjs";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const testsHash = (files: Array<[string, string]>) => sha(files.map(([f, text]) => `${f}\0\0${text}`).join("\0"));
const targets = {
  critical: { min: 80, modules: ["a.ts", "b.ts", "c.ts", "d.ts", "gone.ts"] },
  modules: { "a.ts": [{ file: "a.test.ts" }], "b.ts": [{ file: "b.test.ts" }], "c.ts": [{ file: "c.test.ts" }], "d.ts": [] },
};
const files: Record<string, string> = { "a.ts": "A", "b.ts": "B", "c.ts": "C2", "d.ts": "D", "a.test.ts": "ta", "b.test.ts": "tb", "c.test.ts": "tc" };
const read = (p: string) => files[p] ?? null;

describe("mutation receipt check (W4.17)", () => {
  it("passes a current score of at least 80, fails a low, stale or missing one, and skips an absent module", () => {
    const receipt = {
      modules: {
        "a.ts": { score: 80, sha256: sha("A"), tests: testsHash([["a.test.ts", "ta"]]), date: "2026-11-12" },
        "b.ts": { score: 79.9, sha256: sha("B"), tests: testsHash([["b.test.ts", "tb"]]), date: "2026-11-12" },
        "c.ts": { score: 95, sha256: sha("C"), tests: testsHash([["c.test.ts", "tc"]]), date: "2026-11-12" },
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
    const receipt = { modules: { "a.ts": { score: 90, sha256: sha("A"), tests: "old", date: "2026-11-12" } } };
    const [a] = checkReceipt({ ...targets, critical: { min: 80, modules: ["a.ts"] } }, receipt, read) as Array<{ state: string; testsChanged: boolean }>;
    expect(a).toMatchObject({ state: "ok", testsChanged: true });
  });

  it("the committed receipt covers every critical module on this branch at 80% or more", () => {
    const root = join(__dirname, "..", "..");
    const real = JSON.parse(readFileSync(join(root, "scripts/mutation/targets.json"), "utf8"));
    const receipt = JSON.parse(readFileSync(join(root, "scripts/mutation/receipt.json"), "utf8"));
    const rows = checkReceipt(real, receipt, (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null)) as Array<{ module: string; state: string }>;
    expect(rows.filter((r) => r.state !== "ok" && r.state !== "absent")).toEqual([]);
    expect(real.critical.min).toBe(80);
  });
});
