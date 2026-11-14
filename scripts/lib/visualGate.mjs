/**
 * When may a Playwright run write a visual baseline? (plan W10.B16; audit
 * W2.23, W1.16, 9.5, 9.9, 10.3)
 *
 * Playwright's default (`updateSnapshots: "missing"`) writes a baseline that
 * doesn't exist and lets the next run compare against it: the first run
 * approves itself, and a gate that starts from a clean checkout compares a
 * screenshot with itself. So:
 *
 *   - the gate (CI, LUMEN_CI, LUMEN_GATE): "none", always;
 *   - a local run: "none" too, so a missing baseline fails;
 *   - only `npm run visual:approve` (scripts/visual-approve.mjs), after the
 *     person confirms they looked, sets LUMEN_VISUAL_APPROVE=1 → "changed"
 *     (writes missing baselines and the ones that differ).
 */

const truthy = (v) => v !== undefined && v !== "" && v !== "0" && String(v).toLowerCase() !== "false";

/** @param {Record<string, string | undefined>} env */
export function isGateRun(env) {
  return truthy(env.CI) || truthy(env.LUMEN_CI) || truthy(env.LUMEN_GATE);
}

/**
 * The `updateSnapshots` value for a Playwright config.
 * @param {Record<string, string | undefined>} env
 * @returns {"none" | "changed"}
 */
export function snapshotUpdateMode(env) {
  if (isGateRun(env)) return "none";
  return env.LUMEN_VISUAL_APPROVE === "1" ? "changed" : "none";
}
