/**
 * Count a command run (plan W4.26) without putting the counters in the
 * startup bundle: the counter module loads on first use. Local only; see
 * ./usage.ts.
 */
export function countCommand(id: string): void {
  void import("./usage").then((m) => m.countFeature(id)).catch(() => {
    // why: a counter that fails to load must never break the command
  });
}

/** At startup, once the app is idle: count the open, listen for errors, and remind about the weekly report when it is due. */
export function startUsageCounting(): void {
  void import("./usage")
    .then((m) => {
      m.countOpen();
      m.listenForErrors();
      if (m.weeklyDue(m.dayKey())) void import("./reminder").then((r) => r.remindWeekly());
    })
    .catch(() => {
      // why: counting is optional; the app runs without it
    });
}
