/**
 * Argon2id parameters for this device (plan W4.20): the most memory that
 * still opens the vault within a time budget (1 s by default).
 *
 * OWASP's Argon2id options trade memory for passes at about the same cost:
 * 46 MiB × 1, 19 MiB × 2, 12 MiB × 3, 9 MiB × 4, 7 MiB × 5. The last three
 * come to 35–36 MiB × passes, under ./kdf.ts's opening floor of 37 MiB, so
 * a vault written with them would not open: only the first two are used.
 * More memory is the stronger choice against GPU and ASIC guessing, so 46 MiB
 * wins when it fits the budget. A device too slow for either gets the
 * cheaper one: the floor is not lowered to make a slow phone faster.
 *
 * The estimate comes from one small run (2 MiB, one pass) of the same
 * Argon2id the vault uses, timed twice; it costs about 1/20 of a real unlock.
 */
import { ARGON2_MIN_COST_KIB, deriveMasterKey, type Argon2idParams } from "./kdf";
import { randomBytes, toB64u } from "./bytes";

export type Argon2Cost = Omit<Argon2idParams, "alg" | "salt">;

/** OWASP Password Storage Cheat Sheet's Argon2id options at or above the floor, strongest first. */
export const ARGON2_OPTIONS: readonly Argon2Cost[] = [
  { memoryKiB: 47_104, iterations: 1, parallelism: 1 },
  { memoryKiB: 19_456, iterations: 2, parallelism: 1 },
];

const PROBE_KIB = 2048;

export interface Calibration extends Argon2Cost {
  /** The estimated time to open the vault with these parameters, ms. */
  estimateMs: number;
  /** The measured cost of one KiB-pass, ms. */
  msPerKiB: number;
}

/** Pick the option for a measured `msPerKiB` (pure; the tests drive it). */
export function chooseArgon2(msPerKiB: number, budgetMs = 1000): Calibration {
  const est = (o: Argon2Cost) => msPerKiB * o.memoryKiB * o.iterations;
  const fits = ARGON2_OPTIONS.find((o) => est(o) <= budgetMs);
  const pick = fits ?? ARGON2_OPTIONS.reduce((a, b) => (est(b) < est(a) ? b : a));
  if (pick.memoryKiB * pick.iterations < ARGON2_MIN_COST_KIB) throw new Error("Argon2id option below the floor");
  return { ...pick, estimateMs: Math.round(est(pick)), msPerKiB };
}

let cached: Promise<Calibration> | null = null;

/**
 * Measure this device once per session and pick its parameters.
 * `now` is injectable for tests.
 */
export function calibrateArgon2(budgetMs = 1000, now: () => number = () => performance.now()): Promise<Calibration> {
  cached ??= (async () => {
    const probe: Argon2idParams = { alg: "argon2id", memoryKiB: PROBE_KIB, iterations: 1, parallelism: 1, salt: toB64u(randomBytes(16)) };
    let best = Infinity;
    for (let i = 0; i < 2; i++) {
      const t0 = now();
      await deriveMasterKey("calibration", probe);
      best = Math.min(best, now() - t0);
    }
    // Large memory is a little slower per block (caches); 20 % of headroom.
    return chooseArgon2((best / PROBE_KIB) * 1.2, budgetMs);
  })();
  return cached;
}

/** Tests only: measure again on the next call. */
export function resetArgon2Calibration(): void {
  cached = null;
}
