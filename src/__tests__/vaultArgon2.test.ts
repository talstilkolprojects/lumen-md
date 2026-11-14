/**
 * Plan W4.20: vault encryption at rest uses Argon2id (W1.7's own TypeScript,
 * no new dependency), with the most memory this device opens within 1 s.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ARGON2_OPTIONS, calibrateArgon2, chooseArgon2, resetArgon2Calibration } from "../sync/e2ee/kdfCalibrate";
import { ARGON2_MIN_COST_KIB, validateKdfParams } from "../sync/e2ee/kdf";
import { createRestHeader, unlockRestHeader, WrongPassphraseError } from "../storage/vault/encrypted/format";

afterEach(() => resetArgon2Calibration());

describe("choosing Argon2id parameters for the device", () => {
  it("a fast device gets the most memory (46 MiB × 1)", () => {
    expect(chooseArgon2(0.01)).toMatchObject({ memoryKiB: 47_104, iterations: 1, parallelism: 1, estimateMs: 471 });
  });

  it("a slower one steps down OWASP's options, never below the floor", () => {
    // 46 MiB × 1 would take 1.2 s; 19 MiB × 2 takes 0.99 s.
    expect(chooseArgon2(0.0255)).toMatchObject({ memoryKiB: 19_456, iterations: 2 });
    // Too slow for either within 1 s (a phone): the cheaper one, slower than the budget.
    const slow = chooseArgon2(0.06);
    expect(slow).toMatchObject({ memoryKiB: 19_456, iterations: 2 });
    expect(slow.estimateMs).toBeGreaterThan(1000);
    // A 2 s budget (the Pixel 7 target) lets it keep more memory.
    expect(chooseArgon2(0.04, 2000)).toMatchObject({ memoryKiB: 47_104, iterations: 1 });
  });

  it("every option passes the opening floor of ./kdf.ts", () => {
    for (const o of ARGON2_OPTIONS) {
      expect(o.memoryKiB * o.iterations).toBeGreaterThanOrEqual(ARGON2_MIN_COST_KIB);
      expect(() => validateKdfParams({ alg: "argon2id", ...o, salt: "AAAAAAAAAAAAAAAAAAAAAA" })).not.toThrow();
    }
  });

  it("measures with a small run of the real Argon2id", async () => {
    let t = 0;
    // Each probe run "takes" 41 ms on this fake clock: 0.02 ms per KiB, ×1.2 headroom.
    const now = () => (t += 40.96);
    const c = await calibrateArgon2(1000, now);
    expect(Math.abs(c.msPerKiB - 0.024)).toBeLessThan(1e-9);
    expect(c).toMatchObject({ memoryKiB: 19_456, iterations: 2 });
  });
});

describe("a vault header with Argon2id", () => {
  it("opens with the passphrase and refuses a wrong one", async () => {
    const { header } = await createRestHeader("סיסמה ארוכה מספיק", { argon2: { memoryKiB: 8, iterations: 1, parallelism: 1 } });
    expect(header.passphrase.kdf).toMatchObject({ alg: "argon2id", memoryKiB: 8 });
    await expect(unlockRestHeader(header, "סיסמה ארוכה מספיק")).resolves.toBeTruthy();
    await expect(unlockRestHeader(header, "not it")).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it("gets OWASP's default when nothing is asked for (and opens within the time a real unlock takes)", async () => {
    const { header } = await createRestHeader("a long enough passphrase");
    expect(header.passphrase.kdf).toMatchObject({ alg: "argon2id", memoryKiB: 47_104, iterations: 1, parallelism: 1 });
    const t0 = performance.now();
    await unlockRestHeader(header, "a long enough passphrase");
    // Plain TypeScript, no WebAssembly: about a second on a laptop. The bound
    // is loose for a loaded CI machine; the device's own choice is the
    // calibration above.
    expect(performance.now() - t0).toBeLessThan(20_000);
  }, 30_000);
});
