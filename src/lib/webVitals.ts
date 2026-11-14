/**
 * Web Vitals, measured and kept on this device (plan 12.4).
 *
 * An in-house implementation on PerformanceObserver (the `web-vitals`
 * package isn't a dependency). Five metrics:
 *   - **LCP** Largest Contentful Paint — good ≤ 2.5 s
 *   - **CLS** Cumulative Layout Shift (no recent input) — good ≤ 0.1
 *   - **INP** Interaction to Next Paint (slowest event this session) — good ≤ 200 ms
 *   - **FCP** First Contentful Paint — good ≤ 1.8 s
 *   - **TTFB** Time to First Byte (navigation timing) — good ≤ 800 ms
 *
 * The values are never sent anywhere — not even when error reports are on.
 * They live in memory and are shown in the Runtime metrics panel. A sample
 * carries no page address (a note's path can be in it).
 *
 * Every observer uses `buffered: true`, so this module can load lazily
 * after the first paint and still see the page-load entries.
 */

export type VitalName = "LCP" | "CLS" | "INP" | "FCP" | "TTFB";

export interface VitalsSample {
  /** Metric name. */
  name: VitalName;
  /** Metric value (ms, except CLS: a unitless score). */
  value: number;
  /** Rating against the Web Vitals thresholds. */
  rating: "good" | "needs-improvement" | "poor";
}

/** [good up to, needs-improvement up to] — above is poor. */
const THRESHOLDS: Record<VitalName, [number, number]> = {
  LCP: [2500, 4000],
  CLS: [0.1, 0.25],
  INP: [200, 500],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
};

export const VITAL_NAMES: readonly VitalName[] = ["LCP", "FCP", "TTFB", "INP", "CLS"];

function rate(name: VitalName, v: number): VitalsSample["rating"] {
  const [good, ni] = THRESHOLDS[name];
  if (v <= good) return "good";
  if (v <= ni) return "needs-improvement";
  return "poor";
}

let installed = false;
const observers: PerformanceObserver[] = [];

function observe(type: string, cb: (list: PerformanceObserverEntryList) => void, extra: Record<string, unknown> = {}): void {
  try {
    const o = new PerformanceObserver(cb);
    o.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
    observers.push(o);
  } catch {
    /* why: entry type not supported by this browser */
  }
}

/**
 * Install the observers. Idempotent; a no-op without PerformanceObserver.
 *
 * @param sink invoked for every new value of a metric.
 */
export function reportWebVitals(sink: (sample: VitalsSample) => void): void {
  if (installed) return;
  if (typeof window === "undefined") return;
  if (typeof PerformanceObserver === "undefined") return;
  installed = true;
  const emit = (name: VitalName, value: number) => sink({ name, value, rating: rate(name, value) });

  // LCP — the latest entry is the canonical value.
  observe("largest-contentful-paint", (list) => {
    const entries = list.getEntries();
    const last = entries[entries.length - 1] as (PerformanceEntry & { renderTime: number; loadTime: number }) | undefined;
    if (!last) return;
    emit("LCP", last.renderTime || last.loadTime || last.startTime || 0);
  });

  // CLS — layout shifts not caused by the user's own input.
  let cls = 0;
  observe("layout-shift", (list) => {
    for (const entry of list.getEntries()) {
      const e = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
      if (!e.hadRecentInput) cls += e.value;
    }
    emit("CLS", cls);
  });

  // INP — slowest event-timing entry seen this session (running maximum).
  let worst = 0;
  observe(
    "event",
    (list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration > worst) {
          worst = entry.duration;
          emit("INP", worst);
        }
      }
    },
    { durationThreshold: 16 },
  );

  // FCP — the first-contentful-paint paint entry.
  observe("paint", (list) => {
    for (const entry of list.getEntries()) if (entry.name === "first-contentful-paint") emit("FCP", entry.startTime);
  });

  // TTFB — responseStart of the navigation (after a prerender's activation).
  observe("navigation", (list) => {
    const nav = list.getEntries()[0] as (PerformanceEntry & { responseStart: number; activationStart?: number }) | undefined;
    if (!nav || !(nav.responseStart > 0)) return;
    emit("TTFB", Math.max(0, nav.responseStart - (nav.activationStart ?? 0)));
  });
}

// ─── The local store shown in the Runtime metrics panel ─────────────────

let latest: Partial<Record<VitalName, VitalsSample>> = {};
const listeners = new Set<() => void>();

function record(sample: VitalsSample): void {
  latest = { ...latest, [sample.name]: sample };
  for (const fn of [...listeners]) fn();
}

/** Start measuring into the local store (main.tsx, after the first paint). */
export function startLocalVitals(): void {
  reportWebVitals(record);
}

/** This session's latest value per metric. An immutable snapshot. */
export function vitalsSnapshot(): Partial<Record<VitalName, VitalsSample>> {
  return latest;
}

export function subscribeVitals(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Tear down all observers and the store. Used by tests. */
export function disposeWebVitals(): void {
  for (const o of observers) {
    try {
      o.disconnect();
    } catch {
      /* why: an observer that is already disconnected throws in some browsers */
    }
  }
  observers.length = 0;
  installed = false;
  latest = {};
  listeners.clear();
}
