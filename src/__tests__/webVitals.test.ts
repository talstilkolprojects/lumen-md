/**
 * webVitals.ts — the rating logic, the local-only store (plan 12.4: never
 * sent), and graceful degradation without PerformanceObserver.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { reportWebVitals, disposeWebVitals, startLocalVitals, subscribeVitals, vitalsSnapshot, type VitalsSample } from "../lib/webVitals";

describe("reportWebVitals", () => {
  let originalPO: typeof PerformanceObserver | undefined;
  beforeEach(() => {
    disposeWebVitals();
    localStorage.clear();
    originalPO = (globalThis as { PerformanceObserver?: typeof PerformanceObserver })
      .PerformanceObserver;
  });
  afterEach(() => {
    disposeWebVitals();
    if (originalPO === undefined) {
      delete (globalThis as { PerformanceObserver?: typeof PerformanceObserver })
        .PerformanceObserver;
    } else {
      (globalThis as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver =
        originalPO;
    }
  });

  it("measures on this device only: no request, no beacon — whatever the monitoring consent", () => {
    localStorage.setItem("lumen.monitoring.consent", "1");
    const fetchSpy = vi.fn();
    const beacon = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: beacon });
    const callbacks = new Map<string, (l: PerformanceObserverEntryList) => void>();
    class MockPO {
      private cb: (l: PerformanceObserverEntryList) => void;
      constructor(cb: (l: PerformanceObserverEntryList) => void) {
        this.cb = cb;
      }
      observe(opts: PerformanceObserverInit) {
        callbacks.set(opts.type ?? "", this.cb);
      }
      disconnect() {}
    }
    (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver =
      MockPO as unknown as typeof PerformanceObserver;
    startLocalVitals();
    callbacks.get("largest-contentful-paint")?.({
      getEntries: () => [{ renderTime: 1200, loadTime: 0 }],
    } as unknown as PerformanceObserverEntryList);
    expect(vitalsSnapshot().LCP).toEqual({ name: "LCP", value: 1200, rating: "good" });
    // A sample carries no page address (a note's path can be in it).
    expect(Object.keys(vitalsSnapshot().LCP ?? {}).sort()).toEqual(["name", "rating", "value"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "sendBeacon");
  });

  it("records FCP and TTFB, and notifies subscribers of the local store", () => {
    const callbacks = new Map<string, (l: PerformanceObserverEntryList) => void>();
    const observed: PerformanceObserverInit[] = [];
    class MockPO {
      private cb: (l: PerformanceObserverEntryList) => void;
      constructor(cb: (l: PerformanceObserverEntryList) => void) {
        this.cb = cb;
      }
      observe(opts: PerformanceObserverInit) {
        observed.push(opts);
        callbacks.set(opts.type ?? "", this.cb);
      }
      disconnect() {}
    }
    (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver =
      MockPO as unknown as typeof PerformanceObserver;
    const seen = vi.fn();
    subscribeVitals(seen);
    startLocalVitals();
    // Every observer is buffered: the module loads after the first paint.
    expect(observed.map((o) => o.type).sort()).toEqual(["event", "largest-contentful-paint", "layout-shift", "navigation", "paint"]);
    expect(observed.every((o) => o.buffered === true)).toBe(true);
    callbacks.get("paint")?.({
      getEntries: () => [{ name: "first-paint", startTime: 900 }, { name: "first-contentful-paint", startTime: 2000 }],
    } as unknown as PerformanceObserverEntryList);
    callbacks.get("navigation")?.({
      getEntries: () => [{ responseStart: 1900, activationStart: 0 }],
    } as unknown as PerformanceObserverEntryList);
    expect(vitalsSnapshot().FCP).toEqual({ name: "FCP", value: 2000, rating: "needs-improvement" });
    expect(vitalsSnapshot().TTFB).toEqual({ name: "TTFB", value: 1900, rating: "poor" });
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("is a no-op in environments without PerformanceObserver", () => {
    delete (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver;
    const sink = vi.fn();
    expect(() => reportWebVitals(sink)).not.toThrow();
    expect(sink).not.toHaveBeenCalled();
  });

  it("emits LCP/CLS/INP samples with correct rating tiers", () => {
    const samples: VitalsSample[] = [];
    const sink = (s: VitalsSample) => samples.push(s);

    // Capture the callbacks per `type` for synthetic firing.
    const callbacks = new Map<string, (l: PerformanceObserverEntryList) => void>();
    class MockPO {
      private cb: (l: PerformanceObserverEntryList) => void;
      constructor(cb: (l: PerformanceObserverEntryList) => void) {
        this.cb = cb;
      }
      observe(opts: PerformanceObserverInit) {
        callbacks.set(opts.type ?? "", this.cb);
      }
      disconnect() {}
    }
    (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver =
      MockPO as unknown as typeof PerformanceObserver;

    reportWebVitals(sink);

    // Fire LCP at 1500ms (good).
    callbacks.get("largest-contentful-paint")?.({
      getEntries: () => [{ renderTime: 1500, loadTime: 0 }],
    } as unknown as PerformanceObserverEntryList);

    // Fire CLS — two shifts, one with recent input (ignored), one without.
    callbacks.get("layout-shift")?.({
      getEntries: () => [
        { value: 0.05, hadRecentInput: false },
        { value: 0.3, hadRecentInput: true },
        { value: 0.02, hadRecentInput: false },
      ],
    } as unknown as PerformanceObserverEntryList);

    // Fire INP at 180ms (good).
    callbacks.get("event")?.({
      getEntries: () => [{ duration: 180 }],
    } as unknown as PerformanceObserverEntryList);

    const byName = (n: string) => samples.find((s) => s.name === n);
    expect(byName("LCP")?.value).toBe(1500);
    expect(byName("LCP")?.rating).toBe("good");
    // 0.05 + 0.02 (the 0.3 was dropped for hadRecentInput).
    expect(byName("CLS")?.value).toBeCloseTo(0.07, 2);
    expect(byName("CLS")?.rating).toBe("good");
    expect(byName("INP")?.value).toBe(180);
    expect(byName("INP")?.rating).toBe("good");
  });

  it("rates degraded values correctly", () => {
    const samples: VitalsSample[] = [];
    const sink = (s: VitalsSample) => samples.push(s);
    const callbacks = new Map<string, (l: PerformanceObserverEntryList) => void>();
    class MockPO {
      private cb: (l: PerformanceObserverEntryList) => void;
      constructor(cb: (l: PerformanceObserverEntryList) => void) {
        this.cb = cb;
      }
      observe(opts: PerformanceObserverInit) {
        callbacks.set(opts.type ?? "", this.cb);
      }
      disconnect() {}
    }
    (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver =
      MockPO as unknown as typeof PerformanceObserver;
    reportWebVitals(sink);
    // LCP at 4500ms → poor
    callbacks.get("largest-contentful-paint")?.({
      getEntries: () => [{ renderTime: 4500, loadTime: 0 }],
    } as unknown as PerformanceObserverEntryList);
    // CLS at 0.3 → poor
    callbacks.get("layout-shift")?.({
      getEntries: () => [{ value: 0.3, hadRecentInput: false }],
    } as unknown as PerformanceObserverEntryList);
    // INP at 600ms → poor
    callbacks.get("event")?.({
      getEntries: () => [{ duration: 600 }],
    } as unknown as PerformanceObserverEntryList);

    expect(samples.find((s) => s.name === "LCP")?.rating).toBe("poor");
    expect(samples.find((s) => s.name === "CLS")?.rating).toBe("poor");
    expect(samples.find((s) => s.name === "INP")?.rating).toBe("poor");
  });

  it("rates needs-improvement tier correctly", () => {
    const samples: VitalsSample[] = [];
    const sink = (s: VitalsSample) => samples.push(s);
    const callbacks = new Map<string, (l: PerformanceObserverEntryList) => void>();
    class MockPO {
      private cb: (l: PerformanceObserverEntryList) => void;
      constructor(cb: (l: PerformanceObserverEntryList) => void) {
        this.cb = cb;
      }
      observe(opts: PerformanceObserverInit) {
        callbacks.set(opts.type ?? "", this.cb);
      }
      disconnect() {}
    }
    (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver =
      MockPO as unknown as typeof PerformanceObserver;
    reportWebVitals(sink);
    // LCP 3000 → needs-improvement
    callbacks.get("largest-contentful-paint")?.({
      getEntries: () => [{ renderTime: 3000, loadTime: 0 }],
    } as unknown as PerformanceObserverEntryList);
    expect(samples.find((s) => s.name === "LCP")?.rating).toBe("needs-improvement");
  });

  it("only reports the worst INP across multiple events (running max)", () => {
    const samples: VitalsSample[] = [];
    const sink = (s: VitalsSample) => samples.push(s);
    type Cb = (l: PerformanceObserverEntryList) => void;
    const callbacks = new Map<string, Cb>();
    class MockPO {
      private cb: Cb;
      constructor(c: Cb) {
        this.cb = c;
      }
      observe(opts: PerformanceObserverInit) {
        callbacks.set(opts.type ?? "", this.cb);
      }
      disconnect() {}
    }
    (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver =
      MockPO as unknown as typeof PerformanceObserver;
    reportWebVitals(sink);
    const eventCb = callbacks.get("event");
    expect(eventCb).toBeDefined();
    eventCb!({
      getEntries: () => [{ duration: 100 }, { duration: 300 }, { duration: 150 }],
    } as unknown as PerformanceObserverEntryList);
    // We should see entries with the running maximum: 100 → 300 (no
    // re-report for 150 because it doesn't exceed 300).
    const inpValues = samples.filter((s) => s.name === "INP").map((s) => s.value);
    expect(inpValues).toEqual([100, 300]);
  });
});
