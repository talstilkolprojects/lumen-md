/**
 * Plan W6.31 — the beta programme: joining from the app ties into the
 * desktop beta channel (#492's beta-channel pointer) and the beta flags;
 * the weekly report is a second opt-in built from W4.26's local counters;
 * feedback is a prefilled GitHub issue; nothing makes a request.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BETA_FEEDBACK_LABEL,
  BETA_KEY,
  BETA_REPORT_LABEL,
  betaFeedbackLink,
  betaReport,
  betaReportDue,
  betaReportUrl,
  joinBeta,
  leaveBeta,
  markBetaReported,
  readEnrolment,
  setBetaWeekly,
} from "../beta/programme";
import { bump, loadUsage, type UsageStore } from "../metrics/usage";
import { readOverrides } from "../flags/flags";

function mem(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("joining and leaving", () => {
  it("join: beta update channel, every beta flag on, the day kept; joining again keeps the first day", () => {
    const storage = mem();
    const channels: string[] = [];
    const e = joinBeta({ storage, setChannel: (c) => channels.push(c), today: "2026-11-12" });
    expect(e).toEqual({ v: 1, joined: "2026-11-12", weeklyReport: false, lastReport: null });
    expect(channels).toEqual(["beta"]);
    // The real flag registry: update.checkOnLaunch is in stage beta.
    expect(readOverrides(storage)).toEqual({ "update.checkOnLaunch": true });
    expect(joinBeta({ storage, today: "2026-12-01" }).joined).toBe("2026-11-12");
  });

  it("leave: stable channel, the flags back to the build default, the enrolment gone", () => {
    const storage = mem();
    const channels: string[] = [];
    joinBeta({ storage, today: "2026-11-12" });
    leaveBeta({ storage, setChannel: (c) => channels.push(c) });
    expect(channels).toEqual(["stable"]);
    expect(readOverrides(storage)).toEqual({});
    expect(storage.getItem(BETA_KEY)).toBeNull();
    expect(readEnrolment(storage)).toBeNull();
  });

  it("a broken or foreign value is not an enrolment", () => {
    const storage = mem();
    for (const raw of ["{", "null", '{"v":2,"joined":"2026-11-12"}', '{"v":1,"joined":"12/11/2026"}']) {
      storage.setItem(BETA_KEY, raw);
      expect(readEnrolment(storage), raw).toBeNull();
    }
  });

  it("the desktop channel 'beta' is the release pipeline's beta-channel pointer (#492)", () => {
    const rs = read("src-tauri/src/updates.rs");
    expect(rs).toContain("releases/download/beta-channel/latest.json");
    expect(read("scripts/lib/releaseRun.mjs")).toContain("releases/download/beta-channel/latest.json");
  });
});

describe("the weekly report: a second opt-in, counts only", () => {
  const ids = ["file.new", "help.beta", "template.apply"];
  const counted = (): UsageStore => {
    let s = loadUsage(null);
    for (const d of ["2026-11-02", "2026-11-03", "2026-11-09", "2026-11-10", "2026-11-11"]) {
      s = bump(s, { kind: "open" }, d);
      s = bump(s, { kind: "feature", id: "file.new" }, d);
    }
    s = bump(s, { kind: "feature", id: "template.installed.My secret plan" }, "2026-11-11");
    return s;
  };

  it("off by default; due once a week after it is turned on", () => {
    const storage = mem();
    expect(betaReportDue("2026-11-12", storage)).toBe(false);
    joinBeta({ storage, today: "2026-11-02" });
    expect(betaReportDue("2026-11-12", storage)).toBe(false);
    setBetaWeekly(true, storage);
    expect(betaReportDue("2026-11-12", storage)).toBe(true);
    markBetaReported("2026-11-12", storage);
    expect(betaReportDue("2026-11-18", storage)).toBe(false);
    expect(betaReportDue("2026-11-19", storage)).toBe(true);
    setBetaWeekly(false, storage);
    expect(betaReportDue("2026-11-30", storage)).toBe(false);
    // Not joined: nothing to turn on.
    expect(setBetaWeekly(true, mem())).toBeNull();
  });

  it("is W4.26's report plus cohort, weeks in the beta and channel — nothing else", () => {
    const e = { v: 1 as const, joined: "2026-11-04", weeklyReport: true, lastReport: null };
    const r = betaReport(counted(), e, "2026-11-12", ids, "beta", "0.2.0-beta.1");
    expect(Object.keys(r).sort()).toEqual(
      ["activatedWeeksAgo", "app", "channel", "cohort", "daysActive30", "daysActive7", "errors7", "kind", "opens7", "retained30", "retained7", "topFeatures", "unusedFeatures", "v", "week", "weeksInBeta"].sort(),
    );
    expect(r).toMatchObject({ kind: "lumen-beta-report", cohort: "2026-11-02", weeksInBeta: 1, channel: "beta", week: "2026-11-09", daysActive7: 3, opens7: 3, app: "0.2.0-beta.1" });
    // The app's own command ids only; a template file name never appears.
    expect(r.topFeatures).toEqual({ "file.new": 5, "template.apply": 1 });
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("leaves only as a prefilled issue labelled beta-report", () => {
    const e = { v: 1 as const, joined: "2026-11-04", weeklyReport: true, lastReport: null };
    const r = betaReport(counted(), e, "2026-11-12", ids, "stable", "0.2.0");
    const u = new URL(betaReportUrl(r));
    expect(u.origin + u.pathname).toBe("https://github.com/talstilkol/lumen-md/issues/new");
    expect(u.searchParams.get("labels")).toBe(BETA_REPORT_LABEL);
    expect(u.searchParams.get("title")).toBe("Beta report: week of 2026-11-09 (cohort 2026-11-02, Lumen 0.2.0)");
    const body = u.searchParams.get("body")!;
    expect(JSON.parse(body.replace(/^```json\n/, "").replace(/\n```\n$/, ""))).toEqual(r);
  });
});

describe("feedback without a server", () => {
  it("a prefilled issue labelled beta-feedback and its kind, with the week in the beta", () => {
    const l = betaFeedbackLink({ kind: "bug", area: "hebrew", title: "  הנקודה  קופצת ", description: "בסוף שורה", weeksInBeta: 2 });
    const u = new URL(l.url);
    expect(l.withBody).toBe(true);
    expect(u.searchParams.get("labels")).toBe(`${BETA_FEEDBACK_LABEL},bug`);
    expect(u.searchParams.get("title")).toBe("[beta] Bug (hebrew): הנקודה קופצת");
    expect(u.searchParams.get("body")).toContain("בסוף שורה");
    expect(u.searchParams.get("body")).toContain("- Week in the beta: 3");
    expect(new URL(betaFeedbackLink({ kind: "idea", area: "other", title: "x", description: "" }).url).searchParams.get("labels")).toBe("beta-feedback,enhancement");
  });

  it("a text too long for a link: the title only, and the body for the clipboard", () => {
    const l = betaFeedbackLink({ kind: "question", area: "ai", title: "long", description: "א".repeat(5000) });
    expect(l.withBody).toBe(false);
    expect(new URL(l.url).searchParams.has("body")).toBe(false);
    expect(l.body).toContain("א".repeat(5000));
  });
});

describe("no request, and the wiring", () => {
  it("the module and the panel make no request of their own", () => {
    for (const f of ["src/beta/programme.ts", "src/beta/reminder.ts", "src/ui/BetaPanel.tsx"]) {
      expect(read(f), f).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|new WebSocket|new Image\(/);
    }
    const panel = read("src/ui/BetaPanel.tsx");
    // Every way out is the tester's click, and is listed in the privacy ledger.
    expect(panel.match(/window\.open\(/g)?.length).toBe(1);
    expect(panel).toMatch(/window\.open\(url[^)]*\);\n\s*recordUserShare\(url/);
  });

  it("the palette command opens the panel with every command id; the reminder is lazy", () => {
    expect(read("src/commands/domains/ai.ts")).toMatch(/id: "help\.beta"[\s\S]{0,300}lumen-open-beta/);
    const app = read("src/App.tsx");
    expect(app).toContain('window.addEventListener("lumen-open-beta", onBeta)');
    expect(app).toContain('import("./ui/BetaPanel").then((m) => m.openBeta({ commandIds: commandIds() }))');
    expect(read("src/metrics/count.ts")).toMatch(/import\("\.\.\/beta\/programme"\)[\s\S]{0,200}import\("\.\.\/beta\/reminder"\)/);
  });
});
