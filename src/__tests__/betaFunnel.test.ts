/**
 * Plan W6.31 — the beta funnel reads only the reports testers sent (the
 * `beta-report` issues or saved copies), with the report format the app
 * produces (src/beta/programme.ts), and nothing else.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain .mjs helpers without types
import { funnel, funnelMarkdown, parseReport } from "../../scripts/lib/betaFunnel.mjs";
import { betaReport, betaReportUrl, type BetaEnrolment } from "../beta/programme";
import { bump, loadUsage, shiftDay, type UsageStore } from "../metrics/usage";

/** A tester who used Lumen on `days` of the week before `today`. */
function store(today: string, days: number): UsageStore {
  let s = loadUsage(null);
  for (let i = days - 1; i >= 0; i--) s = bump(s, { kind: "open" }, shiftDay(today, -i));
  return s;
}
const issueBody = (joined: string, today: string, days: number) => {
  const e: BetaEnrolment = { v: 1, joined, weeklyReport: true, lastReport: null };
  return new URL(betaReportUrl(betaReport(store(today, days), e, today, [], "beta", "0.2.0-beta.1"))).searchParams.get("body")!;
};

describe("the reports", () => {
  it("reads the issue body the app writes, and only beta reports", () => {
    const r = parseReport(issueBody("2026-11-02", "2026-11-12", 4));
    expect(r).toMatchObject({ week: "2026-11-09", cohort: "2026-11-02", daysActive7: 4, channel: "beta", weeksInBeta: 1 });
    expect(parseReport('```json\n{"kind":"lumen-usage-report","v":1}\n```')).toBeNull();
    expect(parseReport("not json")).toBeNull();
    expect(parseReport('{"kind":"lumen-beta-report","v":1,"week":"2026-11-09","cohort":"2026-11-02","daysActive7":9}')).toBeNull();
  });

  it("keeps only the known fields (nothing a hand-edited report adds)", () => {
    const r = parseReport(JSON.stringify({ kind: "lumen-beta-report", v: 1, week: "2026-11-09", cohort: "2026-11-02", daysActive7: 3, email: "a@b.c", topFeatures: { "file.new": 2, "my secret file": 1 } }));
    expect(JSON.stringify(r)).not.toContain("a@b.c");
    expect(r.topFeatures).toEqual({ "file.new": 2 });
  });
});

describe("the funnel", () => {
  const recs = [
    { tester: "a", text: issueBody("2026-11-02", "2026-11-05", 4) },
    { tester: "a", text: issueBody("2026-11-02", "2026-11-12", 10) },
    { tester: "b", text: issueBody("2026-11-02", "2026-11-12", 2) },
    { tester: "c", text: issueBody("2026-11-09", "2026-11-12", 3) },
    { tester: "c", text: issueBody("2026-11-09", "2026-11-12", 5) }, // a resend for the same week replaces the first
    { tester: "d", text: "a comment, not a report" },
  ];

  it("stages, weeks and cohorts; one report per tester and week", () => {
    const f = funnel(recs, { target: 2 });
    expect(f.reports).toBe(4);
    expect(f.skipped).toBe(1);
    expect(f.stages).toEqual({ reported: 3, active: 2, allWeek: 1, retained: 1, secondWeek: 2 });
    expect(f.weeks).toEqual([
      { week: "2026-11-02", reported: 1, active: 1, allWeek: 0, beta: 1 },
      { week: "2026-11-09", reported: 3, active: 2, allWeek: 1, beta: 3 },
    ]);
    expect(f.cohorts.map((c: { cohort: string; testers: number }) => [c.cohort, c.testers])).toEqual([
      ["2026-11-02", 2],
      ["2026-11-09", 1],
    ]);
    expect(f.target).toEqual({ active: 2, bestWeek: "2026-11-09", bestActive: 2, met: true });
    expect(funnel(recs).target.met).toBe(false);
    expect(funnelMarkdown(f)).toContain("| פעילים ≥ 3 ימים בשבוע (active) | 2 | 67% |");
  });

  it("the command line reads a folder of saved reports, one subfolder per tester", () => {
    const dir = mkdtempSync(join(tmpdir(), "beta-funnel-"));
    for (const [i, r] of recs.entries()) {
      mkdirSync(join(dir, r.tester), { recursive: true });
      writeFileSync(join(dir, r.tester, `${i}.md`), r.text);
    }
    const out = execFileSync(process.execPath, ["scripts/beta-funnel.mjs", dir, "--json", "--target", "2"], { encoding: "utf8" });
    expect(JSON.parse(out).stages).toEqual({ reported: 3, active: 2, allWeek: 1, retained: 1, secondWeek: 2 });
  });
});
