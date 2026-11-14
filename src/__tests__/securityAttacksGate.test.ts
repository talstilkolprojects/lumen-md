/**
 * W10.D6 (plan W6.3/W6.4): the crypto attack tests live in the repo and run
 * as a gate: in vitest's include, as their own Vercel gate on preview and
 * production, and in the train's offline gate. They import this checkout,
 * never a reviewer's worktree or the scratchpad.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error — plain .mjs script without type declarations
import { GATES, PREVIEW_GATES, PRODUCTION_GATES } from "../../scripts/vercel-build.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { attackFiles, green, parseCounts } from "../../scripts/train-offline.mjs";

const files = attackFiles();

describe("security/attacks is a gate", () => {
  it("holds the re-review and seventh-review attack suites", () => {
    for (const t of ["t1-legacy-downgrade", "t3-preplant-manifest", "t4-thaw-race", "t5-fresh-rollback", "t6-prev-after-change", "t8-cas-fork"]) {
      expect(files).toContain(`security/attacks/rr12-${t}.test.ts`);
    }
    for (const n of ["1-freeze-lockout", "2-dropped-marker-replay", "3-pairing-downgrade", "4-pairing-races", "5-consent-kdf-sticky"]) {
      expect(files).toContain(`security/attacks/rr7-${n}.test.ts`);
    }
  });

  it("imports only this checkout (no absolute worktree, no scratchpad)", () => {
    for (const f of [...files, "security/attacks/common.ts"]) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/\/home\/claude|\/tmp\/|scratchpad|RR7_W|await import\(`\$\{/);
    }
  });

  it("vitest's include covers them", () => {
    expect(readFileSync("vite.config.ts", "utf8")).toContain('"security/attacks/**/*.test.ts"');
    expect(JSON.parse(readFileSync("package.json", "utf8")).scripts["test:attacks"]).toBe("vitest run security/attacks");
  });

  it("is its own Vercel gate on preview and production builds", () => {
    expect(GATES.attacks).toEqual(["run", "-s", "test:attacks"]);
    expect(PREVIEW_GATES).toContain("attacks");
    expect(PRODUCTION_GATES).toContain("attacks");
  });

  it("the offline gate counts a file green only with a pass and no failure", () => {
    expect(parseCounts("x\nv4: node pass 3 fail 0\n")).toEqual({ pass: 3, fail: 0 });
    expect(green(parseCounts("v4: node pass 3 fail 0"))).toBe(true);
    expect(green(parseCounts("v4: node pass 2 fail 1"))).toBe(false);
    expect(green(parseCounts("v4: node pass 0 fail 0"))).toBe(false);
    expect(green(parseCounts("v4: node load error"))).toBe(false);
  });
});
