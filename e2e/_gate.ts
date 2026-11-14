/**
 * Is this e2e run the gate (Buildkite, any CI, or an explicit LUMEN_GATE),
 * or a developer's local run? (plan W10.B17, audit 3.7)
 *
 * A scenario that needs a tool on the machine (G3 needs `git http-backend`)
 * may skip on a laptop that lacks it, but must fail on the gate: a gate
 * that skips the data-loss scenario it exists to run protects nothing.
 *
 * No Playwright import here, so the unit tests can load it.
 */

type Env = Record<string, string | undefined>;

const truthy = (v: string | undefined): boolean => v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";

/** True on the gate: CI, LUMEN_CI (set by .buildkite/pipeline.yml) or LUMEN_GATE. */
export function isGateRun(env: Env): boolean {
  return truthy(env.CI) || truthy(env.LUMEN_CI) || truthy(env.LUMEN_GATE);
}

/**
 * What a scenario does when a tool it needs is or isn't there:
 *   "run"  — the tool is there;
 *   "skip" — it is missing on a local run (the skip names the tool);
 *   "fail" — it is missing on the gate.
 */
export function missingToolVerdict(available: boolean, env: Env): "run" | "skip" | "fail" {
  if (available) return "run";
  return isGateRun(env) ? "fail" : "skip";
}
