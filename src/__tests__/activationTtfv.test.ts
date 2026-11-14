/**
 * Plan W11.P4 — activation and time to first value, counted on the device
 * only (src/metrics/activation.ts), and in the opt-in beta report only as
 * yes/no facts and averages. The funnel holds the beta targets in code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ACTIVATION_KEY, ACTIVATION_EVENTS, TTFV1_KEEP, __resetSession, loadActivation, markActivation, newSession, record, summarizeActivation, type ActivationStore } from "../metrics/activation";
import { COUNTING_KEY, bump, loadUsage, setCounting, shiftDay, USAGE_KEY } from "../metrics/usage";
import { betaReport, betaReportUrl, type BetaEnrolment } from "../beta/programme";
import { __resetLedger, ledgerEntries } from "../ai/privacyLedger";
// @ts-expect-error — plain .mjs helpers without types
import { BETA_TARGETS, funnel, funnelMarkdown, parseReport } from "../../scripts/lib/betaFunnel.mjs";

const empty = (): ActivationStore => loadActivation(null);
const D0 = "2026-11-02";

describe("the events (pure)", () => {
  it("firstRun.start keeps the first day only; TTFV-2 is the same session's first own save", () => {
    const ses = newSession();
    let s = record(empty(), "firstRun.start", D0, 1_000, ses);
    s = record(s, "firstRun.start", shiftDay(D0, 1), 9_000, ses);
    expect(s.firstRunDay).toBe(D0);
    s = record(s, "note.firstOwnSave", D0, 38_400, ses);
    expect(s).toMatchObject({ firstOwnSaveDay: D0, ttfv2Ms: 37_400, ttfv2AcrossSessions: false });
    // A second own save changes nothing.
    expect(record(s, "note.firstOwnSave", D0, 99_000, ses)).toEqual(s);
  });

  it("a first own save in a later session leaves TTFV-2 unknown, and says why", () => {
    const s = record(record(empty(), "firstRun.start", D0, 1_000, newSession()), "note.firstOwnSave", shiftDay(D0, 1), 5_000, newSession());
    expect(s).toMatchObject({ ttfv2Ms: null, ttfv2AcrossSessions: true, firstOwnSaveDay: shiftDay(D0, 1) });
  });

  it("editor.ready is TTFV-1: once per session, the last 20 launches kept", () => {
    let s = empty();
    for (let i = 0; i < 25; i++) {
      const ses = newSession();
      s = record(s, "editor.ready", D0, 1000 + i, ses);
      s = record(s, "editor.ready", D0, 99_999, ses); // a second editor in the same page load is not a launch
    }
    expect(s.ttfv1Ms).toHaveLength(TTFV1_KEEP);
    expect(s.ttfv1Ms[0]).toBe(1005);
    expect(s.ttfv1Ms.at(-1)).toBe(1024);
  });

  it("import.complete needs at least one note; day2.return needs a later day than the first run", () => {
    const ses = newSession();
    let s = record(empty(), "import.complete", D0, 0, ses, { notes: 0 });
    expect(s.imports).toBe(0);
    s = record(s, "import.complete", D0, 0, ses, { notes: 12 });
    expect(s).toMatchObject({ imports: 1, firstImportDay: D0 });
    expect(record(s, "day2.return", D0, 0, ses).day2ReturnDay).toBeNull(); // no first run yet
    s = record(s, "firstRun.start", D0, 0, ses);
    expect(record(s, "day2.return", D0, 0, ses).day2ReturnDay).toBeNull(); // same day
    expect(record(s, "day2.return", shiftDay(D0, 3), 0, ses).day2ReturnDay).toBe(shiftDay(D0, 3));
  });
});

describe("activation (R6 §1.2): own note or import, plus a return on a second day within 7 days", () => {
  const ses = () => newSession();
  const base = () => record(empty(), "firstRun.start", D0, 0, ses());
  it("own note + return on day 3 → activated", () => {
    const s = record(record(base(), "note.firstOwnSave", D0, 0, ses()), "day2.return", shiftDay(D0, 3), 0, ses());
    expect(summarizeActivation(s, shiftDay(D0, 3)).activated).toBe(true);
  });
  it("import + return → activated, with no note of the user's own", () => {
    const s = record(record(base(), "import.complete", D0, 0, ses(), { notes: 3 }), "day2.return", shiftDay(D0, 1), 0, ses());
    expect(summarizeActivation(s, shiftDay(D0, 1))).toMatchObject({ activated: true, ownNote: false, imported: true });
  });
  it("still inside the 7 days without a return → null (not yet decided), after them → false", () => {
    const s = record(base(), "note.firstOwnSave", D0, 0, ses());
    expect(summarizeActivation(s, shiftDay(D0, 6)).activated).toBeNull();
    expect(summarizeActivation(s, shiftDay(D0, 8)).activated).toBe(false);
  });
  it("a return after day 7 does not activate", () => {
    const s = record(record(base(), "note.firstOwnSave", D0, 0, ses()), "day2.return", shiftDay(D0, 9), 0, ses());
    expect(summarizeActivation(s, shiftDay(D0, 9)).activated).toBe(false);
  });
  it("averages only: TTFV-1 mean to 100 ms, TTFV-2 to the second", () => {
    const s: ActivationStore = { ...base(), ttfv1Ms: [1234, 1501, 1980], ttfv2Ms: 41_620 };
    expect(summarizeActivation(s, D0)).toMatchObject({ ttfv1MeanMs: 1600, ttfv1Launches: 3, ttfv2Ms: 42_000 });
  });
});

describe("on the device (localStorage)", () => {
  beforeEach(() => {
    localStorage.clear();
    __resetSession();
  });

  it("every event lands in lumen.activation.v1, and the stored value is days, facts and durations only", () => {
    const at = new Date(2026, 10, 2, 9, 41, 17);
    markActivation("firstRun.start", { at, now: 900 });
    markActivation("editor.ready", { at, now: 1300 });
    markActivation("note.firstOwnSave", { at, now: 30_900 });
    markActivation("import.complete", { at, notes: 4, now: 40_000 });
    markActivation("day2.return", { at: new Date(2026, 10, 3, 8, 0), now: 500 });
    const raw = localStorage.getItem(ACTIVATION_KEY)!;
    expect(JSON.parse(raw)).toEqual({ v: 1, firstRunDay: "2026-11-02", firstOwnSaveDay: "2026-11-02", firstImportDay: "2026-11-02", imports: 1, day2ReturnDay: "2026-11-03", ttfv1Ms: [1300], ttfv2Ms: 30_000, ttfv2AcrossSessions: false });
    expect(raw).not.toMatch(/T\d\d:|09:41|"at"|path|name/);
  });

  it("nothing is kept while counting is off (W4.26's switch)", () => {
    localStorage.setItem(COUNTING_KEY, "0");
    for (const e of ACTIVATION_EVENTS) markActivation(e, { notes: 1 });
    expect(localStorage.getItem(ACTIVATION_KEY)).toBeNull();
  });

  it("turning counting off clears the activation marks too", () => {
    markActivation("firstRun.start");
    expect(localStorage.getItem(ACTIVATION_KEY)).not.toBeNull();
    setCounting(false);
    expect(localStorage.getItem(ACTIVATION_KEY)).toBeNull();
    expect(localStorage.getItem(USAGE_KEY)).toBeNull();
  });

  it("a broken or foreign value reads as empty", () => {
    localStorage.setItem(ACTIVATION_KEY, "{oops");
    expect(loadActivation()).toEqual(empty());
    localStorage.setItem(ACTIVATION_KEY, JSON.stringify({ v: 1, firstRunDay: "yesterday", ttfv1Ms: [-1, 2e9, 800, "x"], ttfv2Ms: "fast" }));
    expect(loadActivation()).toMatchObject({ firstRunDay: null, ttfv1Ms: [800], ttfv2Ms: null });
  });
});

describe("the privacy ledger: the counters do not leave without consent", () => {
  const spies: Array<ReturnType<typeof vi.fn>> = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    spies.length = 0;
  });

  it("all five events, the summary and the beta report make 0 requests and 0 ledger entries", () => {
    __resetLedger();
    localStorage.clear();
    __resetSession();
    const fetchSpy = vi.fn();
    const xhr = vi.fn();
    const ws = vi.fn();
    spies.push(fetchSpy, xhr, ws);
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("XMLHttpRequest", xhr);
    vi.stubGlobal("WebSocket", ws);
    const nav = globalThis.navigator as Navigator & { sendBeacon?: unknown };
    const had = "sendBeacon" in nav;
    const prev = nav.sendBeacon;
    const beacon = vi.fn();
    Object.defineProperty(nav, "sendBeacon", { configurable: true, writable: true, value: beacon });
    try {
      for (const e of ACTIVATION_EVENTS) markActivation(e, { notes: 2 });
      const sum = summarizeActivation(loadActivation(), "2026-11-14");
      const e: BetaEnrolment = { v: 1, joined: "2026-11-02", weeklyReport: true, lastReport: null };
      betaReportUrl(betaReport(loadUsage(), e, "2026-11-14", [], "beta", "0.2.0-beta.1", sum));
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(xhr).not.toHaveBeenCalled();
      expect(ws).not.toHaveBeenCalled();
      expect(beacon).not.toHaveBeenCalled();
      expect(ledgerEntries()).toEqual([]);
    } finally {
      if (had) Object.defineProperty(nav, "sendBeacon", { configurable: true, writable: true, value: prev });
      else delete (nav as { sendBeacon?: unknown }).sendBeacon;
    }
  });

  it("the activation module has no network primitive at all", () => {
    const src = readFileSync("src/metrics/activation.ts", "utf8");
    expect(src).not.toMatch(/\bfetch\s*\(|sendBeacon|XMLHttpRequest|new\s+(Image|WebSocket|EventSource)\b|window\.open/);
  });

  it("the beta report carries only the summary's seven fields, whatever is passed", () => {
    const e: BetaEnrolment = { v: 1, joined: "2026-11-02", weeklyReport: true, lastReport: null };
    const smuggled = { activated: true, ownNote: true, imported: false, returnedDay2: true, ttfv1MeanMs: 1400, ttfv1Launches: 4, ttfv2Ms: 52_000, samples: [1, 2, 3], note: "secret.md" };
    const r = betaReport(loadUsage(null), e, "2026-11-14", [], "beta", "x", smuggled);
    expect(Object.keys(r.activation!).sort()).toEqual(["activated", "imported", "ownNote", "returnedDay2", "ttfv1Launches", "ttfv1MeanMs", "ttfv2Ms"]);
    expect(JSON.stringify(r)).not.toContain("secret.md");
    expect(betaReport(loadUsage(null), e, "2026-11-14", [], "beta", "x").activation).toBeNull();
  });
});

describe("the funnel: beta targets in the report code", () => {
  it("activation ≥ 50%, D7 ≥ 30%, D30 ≥ 15%, frozen", () => {
    expect(BETA_TARGETS).toEqual({ activation: 0.5, d7: 0.3, d30: 0.15 });
    expect(Object.isFrozen(BETA_TARGETS)).toBe(true);
  });

  /** A tester's issue body, made by the app's own report code. */
  function body(today: string, activated: boolean | null, ttfv1: number | null, ttfv2: number | null, activeDays: number[]) {
    let u = loadUsage(null);
    for (const d of [...activeDays].sort((a, b) => b - a)) u = bump(u, { kind: "open" }, shiftDay(today, -d)); // oldest first: the first day counted is activation
    const e: BetaEnrolment = { v: 1, joined: "2026-10-01", weeklyReport: true, lastReport: null };
    const sum = { activated, ownNote: activated === true, imported: false, returnedDay2: activated === true, ttfv1MeanMs: ttfv1, ttfv1Launches: ttfv1 ? 3 : 0, ttfv2Ms: ttfv2 };
    return new URL(betaReportUrl(betaReport(u, e, today, [], "beta", "0.2.0-beta.1", sum))).searchParams.get("body")!;
  }

  it("computes the rates from the reports testers sent, against the targets", () => {
    const today = "2026-11-12";
    const back = [0, 8, 20, 40]; // active this week, the week before, and 30+ days back: retained 7 and 30
    const recs = [
      { tester: "a", text: body(today, true, 1200, 40_000, back) },
      { tester: "b", text: body(today, false, 1800, null, [0]) },
      { tester: "c", text: body(today, null, null, null, [0]) }, // not decided yet: left out of the rate
      { tester: "d", text: body(today, true, 1500, 70_000, back) },
    ];
    expect(parseReport(recs[0].text).activation).toEqual({ activated: true, ownNote: true, imported: false, returnedDay2: true, ttfv1MeanMs: 1200, ttfv2Ms: 40_000 });
    const f = funnel(recs);
    expect(f.beta.activation).toEqual({ yes: 2, of: 3, rate: 2 / 3, target: 0.5, met: true });
    expect(f.beta.d7.target).toBe(0.3);
    expect(f.beta.d30.target).toBe(0.15);
    expect(f.beta.d7).toMatchObject({ yes: 2, of: 2, met: true });
    expect(f.beta.d30).toMatchObject({ yes: 2, of: 2, met: true });
    expect(f.beta.ttfv1MeanMs).toBe(1500);
    expect(f.beta.ttfv2MedianMs).toBe(55_000);
    const md = funnelMarkdown(f);
    expect(md).toContain("≥ 50%");
    expect(md).toContain("≥ 30%");
    expect(md).toContain("≥ 15%");
    expect(md).toContain("67% (2/3)");
  });

  it("no data is not a pass", () => {
    const f = funnel([]);
    expect(f.beta.activation).toMatchObject({ rate: null, met: false });
    expect(funnelMarkdown(f)).toContain("אין נתונים");
  });
});

describe("the app marks the five events where they happen", () => {
  it.each([
    ["src/onboarding/FirstRun.tsx", 'markActivation("firstRun.start")'],
    ["src/editor/Editor.tsx", 'markActivation("editor.ready")'],
    ["src/hooks/useAutosave.ts", 'markActivation("note.firstOwnSave")'],
    ["src/storage/import/ImportWizard.tsx", 'markActivation("import.complete", report.notes)'],
    ["src/onboarding/FirstRun.tsx", 'markActivation("import.complete", r.notes)'],
    ["src/metrics/count.ts", 'markActivation("day2.return")'],
  ] as [string, string][])("%s: %s", (file: string, call: string) => {
    expect(readFileSync(file, "utf8")).toContain(call);
  });
});
