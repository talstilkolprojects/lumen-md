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

/**
 * An activation event (plan W11.P4), local only; see ./activation.ts. The
 * moment is taken now, before the module loads, so TTFV is not stretched by
 * the lazy import.
 */
export function markActivation(event: import("./activation").ActivationEvent, notes?: number): void {
  const now = typeof performance !== "undefined" ? performance.now() : 0;
  void import("./activation").then((m) => m.markActivation(event, { notes, now })).catch(() => {
    // why: a mark that fails to load must never break the app
  });
}

/** At startup, once the app is idle: count the open, listen for errors, and remind about the weekly report (and the beta report, W6.31) when it is due. */
export function startUsageCounting(): void {
  void import("./usage")
    .then((m) => {
      m.countOpen();
      m.listenForErrors();
      markActivation("day2.return");
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
