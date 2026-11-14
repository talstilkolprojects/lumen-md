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

/** At startup, once the app is idle: count the open, listen for errors, and remind about the weekly report (and the beta report, W6.31) when it is due. */
export function startUsageCounting(): void {
  void import("./usage")
    .then((m) => {
      m.countOpen();
      m.listenForErrors();
      if (m.weeklyDue(m.dayKey())) void import("./reminder").then((r) => r.remindWeekly());
      // W6.31: a tester who asked for the weekly beta report is reminded once a week.
      void import("../beta/programme").then((b) => {
        if (b.betaReportDue(m.dayKey())) void import("../beta/reminder").then((r) => r.remindBetaWeekly());
      });
    })
    .catch(() => {
      // why: counting is optional; the app runs without it
    });
}
