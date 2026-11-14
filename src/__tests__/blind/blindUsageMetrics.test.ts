/**
 * Blind tests (plan W6.15, lane B): usage-metrics normalization (#461).
 *
 * Written from the spec only: PR #461's body (with its review 12.11 fix),
 * docs/src/content/docs/security/usage-metrics.md and the public API (declarations
 * emitted by tsc, no function bodies). The test list (U1–U11) was written before any
 * implementation was read; the implementation was then opened only to check the
 * import path. Failing cases are `it.fails` entries that link to a finding in the
 * W6.15 findings list (PR body of test/blind-tests).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FEATURE_ID,
  KEEP_DAYS,
  USAGE_KEY,
  bump,
  countError,
  countFeature,
  countOpen,
  countingEnabled,
  featureId,
  loadUsage,
  prune,
  reportIssueUrl,
  setCounting,
  shiftDay,
  summarize,
  unusedFeatures,
  weeklyDue,
  weeklyReport,
  type UsageStore,
} from "../../metrics/usage";

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

const empty = (): UsageStore => ({ v: 1, firstDay: null, days: {} });
const feat = (s: UsageStore, id: string, day: string, n = 1) => {
  for (let i = 0; i < n; i++) s = bump(s, { kind: "feature", id }, day);
  return s;
};

afterEach(() => vi.restoreAllMocks());

describe("FEATURE_ID and featureId (U1, U2)", () => {
  it("accepts the app's command ids", () => {
    for (const id of ["file.exportHtml", "ai.prompt.en.code_review", "help.feedback", "vault.check", "file.shareLink"]) {
      expect(FEATURE_ID.test(id)).toBe(true);
    }
  });

  it("refuses text, paths, keys, PINs, phone numbers and e-mails", () => {
    for (const id of ["has space", "a/b", "notes\\x", "file.123", "pin 1234", "ABC.def", "x.ABCd", "054-1234567", "dana@example.com", "", "שלום"]) {
      expect(FEATURE_ID.test(id)).toBe(false);
    }
    // F-4 (ambiguity, Low): the docs say "anything you typed can't become one", but
    // "sk-proj-AbCDeF", "danaLevi" and "x.ab12cd34" match FEATURE_ID. They stay on the
    // device: the report's allowlist (tested below) is what keeps them out of the report.
  });

  it("counts each vault-named family under one fixed id", () => {
    expect(featureId("template.installed.interview-dana-levi")).toBe("template.apply");
    expect(featureId("template.installed.x")).toBe("template.apply");
    expect(featureId("plugin:my-plugin:doThing")).toBe("plugin.command");
    expect(["recent.open", "recent.remove"]).toContain(featureId("recent.3f9a2b"));
    expect(featureId("file.exportHtml")).toBe("file.exportHtml");
  });
});

describe("bump (U3, U4)", () => {
  it("stores the family id, never the name made from a file", () => {
    let s = empty();
    s = feat(s, "template.installed.interview-dana-levi", "2026-11-10", 2);
    s = feat(s, "plugin:secret-source-plugin:run", "2026-11-10");
    const json = JSON.stringify(s);
    expect(json).not.toContain("dana");
    expect(json).not.toContain("secret-source");
    expect(s.days["2026-11-10"].features["template.apply"]).toBe(2);
    expect(s.days["2026-11-10"].features["plugin.command"]).toBe(1);
  });

  it("ignores an id that is not a command id", () => {
    const s = feat(empty(), "my secret note.md", "2026-11-10");
    expect(JSON.stringify(s.days["2026-11-10"]?.features ?? {})).toBe("{}");
  });

  // F-3 (Low): the per-day counts are a plain object, so an id named after an
  // Object.prototype member starts from the inherited function: "constructor" is stored
  // as "function Object() { [native code] }11", and the summary and report carry it.
  it("names of Object.prototype count as plain numbers (F-3)", () => {
    let s = empty();
    for (const id of ["constructor", "toString", "hasOwnProperty", "valueOf"]) s = feat(s, id, "2026-11-10", 2);
    const f = s.days["2026-11-10"].features;
    for (const id of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
      expect(Object.prototype.hasOwnProperty.call(f, id) ? f[id] : 0).toBe(2);
    }
    expect(JSON.parse(JSON.stringify(s)).days["2026-11-10"].features.constructor).toBe(2);
  });

  it("an open and an error are counted; the first day is activation", () => {
    let s = bump(empty(), { kind: "open" }, "2026-11-01");
    s = bump(s, { kind: "error" }, "2026-11-02");
    expect(s.firstDay).toBe("2026-11-01");
    expect(s.days["2026-11-01"].opens).toBe(1);
    expect(s.days["2026-11-02"].errors).toBe(1);
  });
});

describe("weeklyReport (U5)", () => {
  const ids = ["file.exportHtml", "help.feedback", "template.installed.interview-dana-levi", "recent.3f9a2b"];

  it("reports no command when it gets no command ids", () => {
    const s = feat(empty(), "file.exportHtml", "2026-11-10", 3);
    expect(weeklyReport(s, "2026-11-12").topFeatures).toEqual({});
  });

  it("a raw family id stored before the fix is never reported", () => {
    const s: UsageStore = { v: 1, firstDay: "2026-11-01", days: { "2026-11-10": { opens: 1, errors: 0, features: { "template.installed.interview-dana-levi": 4, "file.exportHtml": 1 } } } };
    const r = weeklyReport(s, "2026-11-12", ids, "1.0.0");
    expect(JSON.stringify(r)).not.toContain("dana");
    expect(Object.keys(r.topFeatures)).not.toContain("template.installed.interview-dana-levi");
    expect(r.topFeatures["file.exportHtml"]).toBe(1);
  });

  it("is counts only, with exactly the documented keys, and none of the planted secrets", () => {
    let s = empty();
    for (let d = 0; d < 30; d++) {
      const day = shiftDay("2026-11-12", -d);
      s = bump(s, { kind: "open" }, day);
      s = feat(s, "file.exportHtml", day, 2);
      s = feat(s, "template.installed.interview-dana-levi", day);
    }
    s = feat(s, "secret.danaLevi", "2026-11-12"); // matches the pattern but is no app command
    const r = weeklyReport(s, "2026-11-12", ids, "1.2.3");
    expect(Object.keys(r).sort()).toEqual(
      ["kind", "v", "app", "week", "activatedWeeksAgo", "daysActive7", "daysActive30", "retained7", "retained30", "opens7", "errors7", "topFeatures", "unusedFeatures"].sort(),
    );
    const json = JSON.stringify(r);
    for (const secret of ["dana", "Dana", "secret"]) expect(json).not.toContain(secret);
    expect(r.kind).toBe("lumen-usage-report");
    expect(Object.keys(r.topFeatures).length).toBeLessThanOrEqual(20);
    expect(r.topFeatures["template.apply"]).toBe(30);
  });

  it("the week starts on a Monday", () => {
    const r = weeklyReport(empty(), "2026-11-12", [], "x"); // a Thursday
    expect(r.week).toBe("2026-11-09");
  });
});

describe("days (U6, U7)", () => {
  it("shiftDay crosses months, leap days and the Israeli clock changes", () => {
    expect(shiftDay("2024-02-28", 1)).toBe("2024-02-29");
    expect(shiftDay("2025-02-28", 1)).toBe("2025-03-01");
    expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDay("2026-03-26", 2)).toBe("2026-03-28");
    expect(shiftDay("2026-10-24", 2)).toBe("2026-10-26");
    let d = "2026-01-01";
    for (let i = 0; i < 365; i++) d = shiftDay(d, 1);
    expect(d).toBe("2027-01-01");
  });

  it("prune keeps the last 60 days", () => {
    let s = empty();
    for (let i = 0; i < 90; i++) s = bump(s, { kind: "open" }, shiftDay("2026-11-12", -i));
    const p = prune(s, "2026-11-12");
    const days = Object.keys(p.days).sort();
    expect(KEEP_DAYS).toBe(60);
    expect(days.length).toBeLessThanOrEqual(61);
    expect(days.length).toBeGreaterThanOrEqual(60);
    expect(days[days.length - 1]).toBe("2026-11-12");
  });

  it("retention is unknown while the counts are younger than the window", () => {
    const s = bump(empty(), { kind: "open" }, "2026-11-10");
    const sum = summarize(s, "2026-11-12");
    expect(sum.retained7).toBeNull();
    expect(sum.retained30).toBeNull();
    expect(sum.daysActive7).toBe(1);
  });

  it("retained7: used in the week before and again in the latest one", () => {
    let s = bump(empty(), { kind: "open" }, "2026-11-01");
    s = bump(s, { kind: "open" }, "2026-11-11");
    expect(summarize(s, "2026-11-12").retained7).toBe(true);
  });

  it("unused commands are the app's ids that ran in none of the last 30 days", () => {
    const s = feat(empty(), "file.exportHtml", "2026-11-10");
    const sum = summarize(s, "2026-11-12");
    expect(unusedFeatures(sum, ["file.exportHtml", "help.feedback"])).toEqual(["help.feedback"]);
  });
});

describe("switches and storage (U8, U9, U11)", () => {
  it("turning counting off clears the counts and stops counting", () => {
    const st = memStorage();
    const at = new Date(2026, 10, 12, 10);
    countOpen(st, at);
    countFeature("file.exportHtml", st, at);
    expect(st.getItem(USAGE_KEY)).not.toBeNull();
    setCounting(false, st);
    expect(countingEnabled(st)).toBe(false);
    expect(loadUsage(st).days).toEqual({});
    countOpen(st, at);
    countError(st, at);
    expect(loadUsage(st).days).toEqual({});
  });

  it("the weekly reminder is off until the user turns it on", () => {
    expect(weeklyDue("2026-11-12", memStorage())).toBe(false);
  });

  it("the issue link goes to github.com's new-issue form with the report and the label", () => {
    const r = weeklyReport(feat(empty(), "file.exportHtml", "2026-11-10"), "2026-11-12", ["file.exportHtml"], "1.0.0");
    const u = new URL(reportIssueUrl(r));
    expect(u.origin).toBe("https://github.com");
    expect(u.pathname).toBe("/talstilkol/lumen-md/issues/new");
    const all = decodeURIComponent(u.search);
    expect(all).toContain("usage-report");
    expect(all).toContain('"file.exportHtml"');
  });

  it("a missing, broken or foreign stored value is an empty store", () => {
    for (const raw of [null, "", "{", "[]", '{"v":2,"days":{}}', '"text"', '{"v":1,"days":"x"}']) {
      const st = memStorage();
      if (raw !== null) st.setItem(USAGE_KEY, raw);
      const s = loadUsage(st);
      expect(s.days && typeof s.days).toBe("object");
      expect(Object.keys(s.days)).toEqual([]);
    }
  });

  it("a stored __proto__ key doesn't pollute objects", () => {
    const st = memStorage();
    st.setItem(USAGE_KEY, '{"v":1,"firstDay":null,"days":{"__proto__":{"polluted":1},"2026-11-10":{"opens":1,"errors":0,"features":{"__proto__":{"polluted":2}}}}}');
    const s = loadUsage(st);
    countFeature("file.exportHtml", st, new Date(2026, 10, 10, 9));
    summarize(s, "2026-11-12");
    weeklyReport(s, "2026-11-12", ["file.exportHtml"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("no network (U10)", () => {
  it("counting, the summary and the report make 0 requests", () => {
    const fetchSpy = vi.fn();
    const beacon = vi.fn();
    const xhr = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("XMLHttpRequest", xhr);
    vi.stubGlobal("navigator", { ...(globalThis.navigator ?? {}), sendBeacon: beacon });
    const st = memStorage();
    for (let d = 0; d < 30; d++) {
      const at = new Date(2026, 9, 14 + d, 12);
      countOpen(st, at);
      countFeature("file.exportHtml", st, at);
      countError(st, at);
    }
    const s = loadUsage(st);
    weeklyReport(s, "2026-11-12", ["file.exportHtml"]);
    summarize(s, "2026-11-12");
    weeklyDue("2026-11-12", st);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
    expect(xhr).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
