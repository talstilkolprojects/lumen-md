/**
 * Plan W4.26 — product metrics without tracking: counters on this device,
 * a weekly report sent only by the user's click, and nothing on the network
 * without it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  bump,
  COUNTING_KEY,
  countError,
  countFeature,
  countingEnabled,
  countOpen,
  dayKey,
  FEATURE_ID,
  featureId,
  KEEP_DAYS,
  LAST_REPORT_KEY,
  listenForErrors,
  loadUsage,
  markReported,
  reportIssueUrl,
  setCounting,
  setWeekly,
  shiftDay,
  summarize,
  unusedFeatures,
  USAGE_KEY,
  weeklyDue,
  weeklyReport,
  type UsageStore,
} from "../metrics/usage";
import { __resetLedger, ledgerEntries, recordUserShare, USAGE_REPORT_REASON } from "../ai/privacyLedger";

const at = (day: string) => new Date(`${day}T12:00:00`);
const empty = (): UsageStore => ({ v: 1, firstDay: null, days: {} });
/** Days used, as a store: each day one open. */
const usedOn = (...days: string[]) => days.reduce((s, d) => bump(s, { kind: "open" }, d), empty());

beforeEach(() => {
  localStorage.clear();
});

describe("local usage counters (W4.26)", () => {
  it("counts opens, commands and errors per day, on by default", () => {
    expect(countingEnabled()).toBe(true);
    countOpen(localStorage, at("2026-11-12"));
    countOpen(localStorage, at("2026-11-12"));
    countFeature("file.exportHtml", localStorage, at("2026-11-12"));
    countFeature("file.exportHtml", localStorage, at("2026-11-13"));
    countFeature("help.usage", localStorage, at("2026-11-13"));
    countError(localStorage, at("2026-11-13"));
    expect(loadUsage()).toEqual({
      v: 1,
      firstDay: "2026-11-12",
      days: {
        "2026-11-12": { opens: 2, errors: 0, features: { "file.exportHtml": 1 } },
        "2026-11-13": { opens: 0, errors: 1, features: { "file.exportHtml": 1, "help.usage": 1 } },
      },
    });
  });

  it("refuses anything that is not a command id, so nothing typed is ever a counter name", () => {
    for (const bad of ["my secret note", "sk-proj-PLANTEDSECRET1234567890", "pin.4417", "call:0501234567", "ABCdef", "Notes/Plan.md", "sk-live-1234567890abcdef", "שלום", "a b", "", "x".repeat(300), "file.export Html", "javascript:alert(1)"]) {
      expect(FEATURE_ID.test(bad), bad).toBe(false);
      countFeature(bad, localStorage, at("2026-11-12"));
    }
    expect(localStorage.getItem(USAGE_KEY)).toBe(null);
    for (const ok of ["file.exportHtml", "ai.batchCheck", "view.workspace", "vault.toFolder", "palette.ai:summarize", "ai.prompt.en.code_review", "view.h1"]) expect(FEATURE_ID.test(ok), ok).toBe(true);
  });

  it("turning counting off clears the counts and stops counting; on again starts fresh", () => {
    countOpen(localStorage, at("2026-11-12"));
    setCounting(false);
    expect(localStorage.getItem(USAGE_KEY)).toBe(null);
    expect(localStorage.getItem(COUNTING_KEY)).toBe("0");
    countOpen(localStorage, at("2026-11-12"));
    expect(localStorage.getItem(USAGE_KEY)).toBe(null);
    setCounting(true);
    countOpen(localStorage, at("2026-11-13"));
    expect(loadUsage().firstDay).toBe("2026-11-13");
  });

  it(`keeps ${KEEP_DAYS} days and reads damaged or foreign values as empty`, () => {
    let s = empty();
    for (let i = 0; i < 70; i++) s = bump(s, { kind: "open" }, shiftDay("2026-09-01", i));
    const days = Object.keys(s.days).sort();
    expect(days).toHaveLength(KEEP_DAYS);
    expect(days[days.length - 1]).toBe(shiftDay("2026-09-01", 69));
    for (const raw of ["{", "null", '{"v":2,"days":{}}', '{"v":1,"days":{"bad":{"opens":1}}}']) {
      localStorage.setItem(USAGE_KEY, raw);
      expect(Object.keys(loadUsage().days)).toEqual([]);
    }
    localStorage.setItem(USAGE_KEY, JSON.stringify({ v: 1, firstDay: "x", days: { "2026-11-12": { opens: -3, errors: "9", features: { "ok.id": 2, "not an id": 5 } } } }));
    expect(loadUsage()).toEqual({ v: 1, firstDay: null, days: { "2026-11-12": { opens: 0, errors: 0, features: { "ok.id": 2 } } } });
  });

  it("dates are local calendar days", () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("the internal dashboard", () => {
  it("activation, days used and 7- / 30-day retention, unknown while too young", () => {
    const young = summarize(usedOn("2026-11-10", "2026-11-12"), "2026-11-12");
    expect(young).toMatchObject({ activatedOn: "2026-11-10", daysActive7: 2, daysActive30: 2, retained7: null, retained30: null, opens7: 2 });
    const back = summarize(usedOn("2026-11-01", "2026-11-11"), "2026-11-12");
    expect(back).toMatchObject({ retained7: true, retained30: null, daysActive7: 1 });
    const gone = summarize(usedOn("2026-10-01", "2026-11-01"), "2026-11-12");
    expect(gone).toMatchObject({ retained7: false, daysActive7: 0, daysActive30: 1 });
    const month = summarize(usedOn("2026-09-20", "2026-10-20", "2026-11-12"), "2026-11-12");
    expect(month).toMatchObject({ retained30: true, retained7: false });
  });

  it("ranks the commands of the last 30 days and names the unused ones", () => {
    let s = empty();
    for (const [id, n, d] of [["a.one", 3, "2026-11-12"], ["b.two", 5, "2026-11-01"], ["c.old", 9, "2026-09-01"]] as const) for (let i = 0; i < n; i++) s = bump(s, { kind: "feature", id }, d);
    const sum = summarize(s, "2026-11-12");
    expect(sum.features30).toEqual([["b.two", 5], ["a.one", 3]]);
    expect(unusedFeatures(sum, ["a.one", "b.two", "c.old", "d.never", "not valid"])).toEqual(["c.old", "d.never"]);
  });
});

describe("the weekly report", () => {
  it("is counts only: no note text, title, path or secret from the vault", () => {
    // Plant vault content and secrets where an app keeps them, then use the app.
    const planted = ["Tal's bank PIN is 4417", "Notes/Private/Diagnosis.md", "sk-proj-PLANTEDSECRET1234567890", "סוד: הסיסמה היא 9933"];
    localStorage.setItem("lumen-md", JSON.stringify({ state: { content: planted[0], filePath: planted[1] } }));
    localStorage.setItem("lumen.ai.openaiKey", planted[2]);
    localStorage.setItem("lumen.workspace.recent", planted[3]);
    countOpen(localStorage, at("2026-11-12"));
    for (const p of planted) countFeature(p, localStorage, at("2026-11-12"));
    countFeature("file.save", localStorage, at("2026-11-12"));
    // A counter name the pattern would accept, but not a command of the app: counted locally, never reported.
    countFeature("tal.notes", localStorage, at("2026-11-12"));
    const report = weeklyReport(loadUsage(), "2026-11-12", ["file.save", "file.open"], "0.0.0-test");
    const json = JSON.stringify(report);
    for (const p of [...planted, "4417", "Diagnosis", "PLANTEDSECRET", "9933", "Tal", "tal.notes"]) expect(json.includes(p), p).toBe(false);
    expect(report).toEqual({
      kind: "lumen-usage-report",
      v: 1,
      app: "0.0.0-test",
      week: "2026-11-09",
      activatedWeeksAgo: 0,
      daysActive7: 1,
      daysActive30: 1,
      retained7: null,
      retained30: null,
      opens7: 1,
      errors7: 0,
      topFeatures: { "file.save": 1 },
      unusedFeatures: 1,
    });
    // Its keys are exactly these: nothing else can ride along.
    expect(Object.keys(report).sort()).toEqual(["activatedWeeksAgo", "app", "daysActive30", "daysActive7", "errors7", "kind", "opens7", "retained30", "retained7", "topFeatures", "unusedFeatures", "v", "week"]);
  });

  it("goes to a GitHub issue form the user opens, labelled usage-report", () => {
    const report = weeklyReport(usedOn("2026-11-12"), "2026-11-12", [], "1.2.3");
    const url = new URL(reportIssueUrl(report));
    expect(url.origin + url.pathname).toBe("https://github.com/talstilkol/lumen-md/issues/new");
    expect(url.searchParams.get("labels")).toBe("usage-report");
    expect(url.searchParams.get("title")).toBe("Usage report: week of 2026-11-09 (Lumen 1.2.3)");
    expect(url.searchParams.get("body")).toContain(JSON.stringify(report, null, 2));
  });

  it("the weekly reminder is off until the user turns it on, then due once a week", () => {
    expect(weeklyDue("2026-11-12")).toBe(false);
    setWeekly(true);
    expect(weeklyDue("2026-11-12")).toBe(true);
    markReported("2026-11-12");
    expect(localStorage.getItem(LAST_REPORT_KEY)).toBe("2026-11-12");
    expect(weeklyDue("2026-11-18")).toBe(false);
    expect(weeklyDue("2026-11-19")).toBe(true);
    setWeekly(false);
    expect(weeklyDue("2026-11-30")).toBe(false);
  });
});

describe("nothing leaves without the user's click", () => {
  const spies: Array<ReturnType<typeof vi.fn>> = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    spies.length = 0;
  });

  it("counting, errors, the dashboard and the report make 0 requests and 0 ledger entries", () => {
    __resetLedger();
    const fetchSpy = vi.fn();
    const beacon = vi.fn();
    const xhr = vi.fn();
    const open = vi.fn();
    spies.push(fetchSpy, beacon, xhr, open);
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("XMLHttpRequest", xhr);
    vi.stubGlobal("open", open);
    const nav = globalThis.navigator as Navigator & { sendBeacon?: unknown };
    const hadBeacon = "sendBeacon" in nav;
    const prevBeacon = nav.sendBeacon;
    Object.defineProperty(nav, "sendBeacon", { configurable: true, writable: true, value: beacon });
    try {
      const target = new EventTarget();
      listenForErrors(target as unknown as Window);
      setWeekly(true);
      for (let i = 0; i < 30; i++) {
        const d = at(shiftDay("2026-10-14", i));
        countOpen(localStorage, d);
        countFeature("file.save", localStorage, d);
        countError(localStorage, d);
      }
      target.dispatchEvent(new Event("error"));
      target.dispatchEvent(new Event("unhandledrejection"));
      const store = loadUsage();
      summarize(store, "2026-11-12");
      weeklyReport(store, "2026-11-12", ["file.save"]);
      weeklyDue("2026-11-12");
      for (const s of spies) expect(s).not.toHaveBeenCalled();
      expect(ledgerEntries()).toEqual([]);
    } finally {
      if (hadBeacon) Object.defineProperty(nav, "sendBeacon", { configurable: true, writable: true, value: prevBeacon });
      else delete (nav as { sendBeacon?: unknown }).sendBeacon;
    }
  });

  it("the user's send is listed in the privacy ledger with its size", () => {
    __resetLedger();
    const report = weeklyReport(usedOn("2026-11-12"), "2026-11-12");
    const url = reportIssueUrl(report);
    const entry = recordUserShare(url, 321);
    expect(entry).toMatchObject({ host: "github.com", method: "OPEN", bytesOut: 321, category: "third-party", reason: USAGE_REPORT_REASON, decision: "allowed" });
    expect(ledgerEntries()).toHaveLength(1);
  });

  it("the counter modules contain no network call at all", () => {
    const dir = join(__dirname, "..", "metrics");
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/\bfetch\s*\(|sendBeacon|XMLHttpRequest|new\s+(Image|WebSocket|EventSource)\b|window\.open/);
    }
  });
});

describe("ids made from vault names never reach the report (review 12.11)", () => {
  it("an installed template, a recent file and a plugin command are counted under one fixed id each", () => {
    expect(featureId("template.installed.interview-dana-levi")).toBe("template.apply");
    expect(featureId("recent.k9x2ab")).toBe("recent.open");
    expect(featureId("recent.remove.k9x2ab")).toBe("recent.remove");
    expect(featureId("plugin:my-diary:open")).toBe("plugin.command");
    expect(featureId("file.save")).toBe("file.save");
    countFeature("template.installed.interview-dana-levi", localStorage, at("2026-11-12"));
    countFeature("template.installed.source-yossi", localStorage, at("2026-11-12"));
    expect(Object.keys(loadUsage().days["2026-11-12"].features)).toEqual(["template.apply"]);
    const ids = ["file.save", "template.installed.interview-dana-levi", "template.installed.source-yossi"];
    const report = weeklyReport(loadUsage(), "2026-11-12", ids, "0.0.0-test");
    expect(report.topFeatures).toEqual({ "template.apply": 2 });
    expect(decodeURIComponent(reportIssueUrl(report))).not.toMatch(/dana|yossi/);
  });

  it("a count kept before this fix, under a file name, is never reported", () => {
    const old = bump(empty(), { kind: "open" }, "2026-11-12");
    old.days["2026-11-12"].features["template.installed.interview-dana-levi"] = 3;
    const report = weeklyReport(old, "2026-11-12", ["template.installed.interview-dana-levi"], "0.0.0-test");
    expect(report.topFeatures).toEqual({});
  });

  it("the allowlist is strict: with no command ids given, no command is reported", () => {
    countFeature("file.save", localStorage, at("2026-11-12"));
    expect(weeklyReport(loadUsage(), "2026-11-12", [], "0.0.0-test").topFeatures).toEqual({});
  });
});

describe("counter names of Object.prototype (blind tests, F-3)", () => {
  it("constructor, toString, hasOwnProperty and valueOf count from 0, also after a reload, and reach the report as numbers", () => {
    const names = ["constructor", "toString", "hasOwnProperty", "valueOf"];
    let s: UsageStore = { v: 1, firstDay: null, days: {} };
    for (const id of names) for (let i = 0; i < 2; i++) s = bump(s, { kind: "feature", id }, "2026-11-10");
    for (const id of names) expect(s.days["2026-11-10"].features[id]).toBe(2);
    localStorage.setItem(USAGE_KEY, JSON.stringify(s));
    const back = bump(loadUsage(), { kind: "feature", id: "constructor" }, "2026-11-10");
    expect(back.days["2026-11-10"].features.constructor).toBe(3);
    expect(JSON.parse(JSON.stringify(back)).days["2026-11-10"].features.toString).toBe(2);
    expect(summarize(back, "2026-11-10").features30).toContainEqual(["constructor", 3]);
    expect(weeklyReport(back, "2026-11-10", names, "0.0.0-test").topFeatures).toMatchObject({ constructor: 3, valueOf: 2 });
  });
});
