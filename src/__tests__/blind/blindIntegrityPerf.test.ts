/**
 * Blind tests (plan W6.15, lane B): the vault integrity check (#356), its speed (I8).
 *
 * A wall-clock budget, so it runs in the nightly perf tier (scripts/test-tiers.mjs
 * VITEST_NIGHTLY_ONLY, W6.8), not the Vercel gate: on a loaded 2-CPU build machine a
 * timing test fails by noise. The number is the spec's and is not loosened. The
 * correctness cases (I1–I7) stay in blindIntegrity.test.ts, in the gate.
 */
import { describe, expect, it } from "vitest";
import { checkVault } from "../../storage/vault/integrity";
import { createMemoryBackend } from "../../storage/vault/memory";

describe("speed (I8)", () => {
  it("checks 10,000 notes in under 5 seconds", async () => {
    const b = createMemoryBackend();
    for (let i = 0; i < 10_000; i++) await b.write(`d${i % 50}/n${i}.md`, `# ${i}\nלינק [[n${(i + 1) % 10_000}]]\n`);
    const t = Date.now();
    const r = await checkVault(b);
    expect(Date.now() - t).toBeLessThan(5000);
    expect(r.files).toBe(10_000);
    expect(r.findings).toEqual([]);
  }, 60_000);
});
