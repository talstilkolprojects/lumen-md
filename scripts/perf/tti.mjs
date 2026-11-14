/**
 * Lighthouse-style TTI / TBT over a list of long tasks (scripts/perf/profile-startup.mjs).
 *
 * TTI is the first moment after FCP that is followed by QUIET_MS without a
 * long task: FCP itself when the first long task starts that late (or there
 * is none), else the end of the last long task before such a window. TBT is
 * the part over 50 ms of every long task between FCP and TTI. When no quiet
 * window fits before `profileEnd`, TTI is not reached and TBT covers the
 * whole window.
 *
 * @param {Array<[number, number]>} longTasks  [startTime, duration] pairs
 * @param {number} fcp
 * @param {number} profileEnd  the end of the observed window
 * @param {number} quietMs
 * @returns {{ tti: number, reached: boolean, tbt: number, longTasks: number }}
 */
export function ttiAndTbt(longTasks, fcp, profileEnd, quietMs = 5000) {
  const after = longTasks.filter(([s, d]) => s + d > fcp).sort((a, b) => a[0] - b[0]);
  let tti = fcp;
  let reached = false;
  // A quiet window right after FCP: interactive at FCP; a later long task
  // (deferred startup work) must not be counted (Codex P1 on #259).
  const firstStart = after.length ? after[0][0] : profileEnd;
  if (firstStart - fcp >= quietMs) reached = true;
  for (let i = 0; !reached && i < after.length; i++) {
    const end = after[i][0] + after[i][1];
    const nextStart = i + 1 < after.length ? after[i + 1][0] : profileEnd;
    if (nextStart - end >= quietMs) {
      tti = end;
      reached = true;
    }
  }
  const window = after.filter(([s]) => (reached ? s < tti : true));
  const tbt = window.reduce((a, [s, d]) => a + Math.max(0, Math.min(s + d, reached ? tti : Infinity) - Math.max(s, fcp) - 50), 0);
  return { tti, reached, tbt, longTasks: window.length };
}
