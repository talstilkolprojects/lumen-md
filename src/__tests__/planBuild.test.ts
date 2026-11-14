// @vitest-environment node
/**
 * Plan 0.6 — the plan as data. plan/plan.json is the source; the board in
 * MASTER_PLAN.md and plan/board.html are generated (scripts/plan/build.mjs).
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildModel,
  renderBoard,
  run,
  fmt,
  dur,
  parseTime,
  spliceBoard,
  BOARD_START,
  BOARD_END,
  renderHtml,
  checkVerified,
  withVerified,
  VERIFIED_LEVELS,
  VERIFIED_LABEL,
  checkDoneLevel,
  checkStatusLength,
  STATUS_MAX,
  wipWarnings,
  formatWip,
  waveNumber,
  belowFloor,
  WIP_LIMIT,
  isStarted,
  // @ts-expect-error — plain .mjs script without type declarations
} from "../../scripts/plan/build.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { classify, prOf, migrate } from "../../scripts/plan/migrate-verified.mjs";

const ROOT = resolve(__dirname, "..", "..");
const plan = () => JSON.parse(readFileSync(join(ROOT, "plan/plan.json"), "utf8"));
const tmp = mkdtempSync(join(tmpdir(), "lumen-plan-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A copy of the plan, the document and the page. */
function copy(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(join(dir, "plan"), { recursive: true });
  for (const f of ["plan/plan.json", "plan/board.html", "MASTER_PLAN.md"]) cpSync(join(ROOT, f), join(dir, f));
  return dir;
}
type Task = { id: string; status?: string; verified?: string; pr?: number; priority: string; dep?: string[]; notes?: string };
const tasks = (p: { phases: { tasks: Task[] }[] }) => p.phases.flatMap((ph) => ph.tasks);

describe("plan build", () => {
  it("the checked-in document and page are what plan.json generates", () => {
    expect(run({ root: ROOT, check: true }).stale).toEqual([]);
  });

  it("formats times and durations like the board", () => {
    expect(fmt(parseTime("2026-10-18T15:20"))).toBe("א׳ 18.10 15:20");
    expect(fmt(parseTime("2026-10-24T09:05"))).toBe("שבת 24.10 09:05");
    expect(dur(45)).toBe("45 דק׳");
    expect(dur(125)).toBe("2 ש׳ 05 דק׳");
  });

  it("a status change is one line in plan.json, and the check catches a stale document", () => {
    const dir = copy("status");
    const path = join(dir, "plan/plan.json");
    const before = readFileSync(path, "utf8");
    // A task that already has a status, edited the way a person would: one line. 0.6 has a
    // dod and isn't grandfathered, so reopening it is one line (a grandfathered task also
    // leaves dodGrandfathered — plan 0.7).
    const line = before.split("\n").find((l) => l.includes('"status": "✅ #251"'))!;
    writeFileSync(path, before.replace(line, line.replace("✅ #251", "⏳ בעבודה")));
    const after = readFileSync(path, "utf8").split("\n");
    expect(after.filter((l, i) => l !== before.split("\n")[i])).toEqual([line.replace("✅ #251", "⏳ בעבודה")]);

    const cli = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, "scripts/plan/build.mjs"), ...args], { cwd: dir, encoding: "utf8" });
    // The CLI works on the repo it lives in, so drive run() for the copy.
    expect(run({ root: dir, check: true }).stale).toEqual(["MASTER_PLAN.md", "plan/board.html"]);
    expect(run({ root: dir }).stale.length).toBe(2);
    expect(run({ root: dir, check: true }).stale).toEqual([]);
    expect(readFileSync(join(dir, "MASTER_PLAN.md"), "utf8")).toContain(`| ⏳ בעבודה |`);
    expect(cli("--check").status).toBe(0); // the repo itself is untouched
  });

  it("CI fails when the board in MASTER_PLAN.md is edited by hand", () => {
    const dir = copy("drift");
    const path = join(dir, "MASTER_PLAN.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("| ✅ #202 |", "| ✅ #999 |"));
    expect(run({ root: dir, check: true }).stale).toEqual(["MASTER_PLAN.md"]);
  });

  it("only the board section is generated; the rest of MASTER_PLAN.md is left as it is", () => {
    const doc = `# head\n\n${BOARD_START} old\nold board\n\n---\n\n${BOARD_END} appendix\ntext\n`;
    expect(spliceBoard(doc, `${BOARD_START} new\n`)).toBe(`# head\n\n${BOARD_START} new\n\n---\n\n${BOARD_END} appendix\ntext\n`);
    expect(() => spliceBoard("# no board", "x")).toThrow(/no board section/);
  });

  it("cut line: a P1 owner item may not wait on a P2 task", () => {
    const p = plan();
    const M = buildModel(plan());
    const p2 = M.agent.find((t: { eff: string }) => t.eff === "P2");
    const p1 = M.owner.find((t: { eff: string }) => t.eff === "P1");
    const item = p.owner.find((o: { id: string }) => o.id === p1.id);
    item.dep = [...item.dep, p2.id];
    const esc = (s: string) => s.replace(".", "\\.");
    expect(() => buildModel(p)).toThrow(new RegExp(`cut line broken.*${esc(p1.id)} \\(P1\\) → ${esc(p2.id)} \\(P2\\)`));
  });

  it("plan.json is kept in one canonical format (one line per status)", () => {
    const text = readFileSync(join(ROOT, "plan/plan.json"), "utf8");
    expect(JSON.stringify(JSON.parse(text), null, 1) + "\n").toBe(text);
    for (const t of tasks(JSON.parse(text))) if (t.status) expect(text).toContain(`"status": ${JSON.stringify(t.status)},`);
  });

  it("an unknown dependency and a cycle are refused", () => {
    const p = plan();
    tasks(p)[3].dep = ["99.9"];
    expect(() => buildModel(p)).toThrow(/depends on unknown 99\.9/);
    const q = plan();
    const [a, b] = [tasks(q).find((t) => t.id === "0.2")!, tasks(q).find((t) => t.id === "0.3")!];
    a.dep = ["0.3"];
    b.dep = ["0.2"];
    expect(() => buildModel(q)).toThrow(/dependency cycle/);
  });

  it("every Markdown table row has as many cells as its header (pipes in the data are escaped)", () => {
    const board: string = renderBoard(buildModel(plan()));
    const cols = (row: string) => row.replace(/\\\|/g, "").split("|").length;
    const lines = board.split("\n");
    let header = 0;
    for (const [i, l] of lines.entries()) {
      if (!l.startsWith("|")) {
        header = 0;
        continue;
      }
      if (!header) header = cols(l);
      else expect(cols(l), `line ${i + 1}: ${l.slice(0, 80)}`).toBe(header);
    }
    expect(board).toContain("`curl -sI <preview>/ \\| grep -i content-security`");
  });

  it("the schedule: no overlap in a lane or a conflict group, dependencies first, nothing in the past", () => {
    const M = buildModel(plan());
    const work = M.all.filter((t: { done?: boolean }) => !t.done);
    for (const t of work) {
      expect(t.start, t.id).toBeGreaterThanOrEqual(M.START);
      for (const d of t.dep) expect(t.start, `${t.id} after ${d}`).toBeGreaterThanOrEqual(M.BYID.get(d).end);
    }
    const keys = (t: { lane: string; g: string[] }) => [`lane:${t.lane}`, ...t.g.map((g) => `group:${g}`)];
    for (const a of work)
      for (const b of work) {
        if (a === b || !keys(a).some((k) => keys(b).includes(k))) continue;
        expect(a.end <= b.start || b.end <= a.start, `${a.id} and ${b.id} overlap`).toBe(true);
      }
    // The plan's start is history: remaining work begins at the update.
    expect(M.START).toBe(parseTime(plan().updated));
  });

  it("non-P0 work backfills a lane that waits on P0 work elsewhere", () => {
    const M = buildModel(plan());
    const release = M.BYID.get("13.5");
    // Wave 10 fills the release's own lane (D) with P0 work up to the release, so it has no
    // idle gap to backfill; the lanes that wait on that P0 work elsewhere must use theirs.
    const others = M.agent.filter((t: { lane: string; done?: boolean }) => t.lane !== release.lane && !t.done);
    for (const lane of new Set(others.map((t: { lane: string }) => t.lane))) {
      const before = others.filter((t: { lane: string; eff: string; end: number }) => t.lane === lane && t.eff !== "P0" && t.end <= release.start);
      expect(before.length, String(lane)).toBeGreaterThan(0);
    }
  });

  it("P0 spreads to what P0 work waits on, and the release waits on every P0 item", () => {
    const M = buildModel(plan());
    const release = M.BYID.get("13.5");
    for (const t of M.all) if (t.eff === "P0" && t.id !== "13.5" && t.lane !== "T") expect(release.dep).toContain(t.id);
    for (const t of M.all) if (t.eff === "P0") for (const d of t.dep) expect(M.BYID.get(d).eff).toBe("P0");
    expect(renderBoard(M)).toContain("#### 15. מה צריך ממך");
    // The final audit waits on everything, the owner's checks included.
    const audit = M.agent.find((t: { depRule?: string }) => t.depRule === "all");
    for (const o of M.owner) expect(audit.dep).toContain(o.id);
    expect(audit.start).toBeGreaterThanOrEqual(Math.max(...M.owner.map((o: { end: number }) => o.end)));
  });

  it("a time with a zone offset or seconds is refused with a clear error, not looped on", () => {
    // Regression: "2026-11-12T11:40:00+02:00" parsed to NaN and the owner-window walk spun forever.
    for (const bad of ["2026-11-12T11:40:00+02:00", "2026-11-12T11:40:00", "2026-11-12T11:40Z", "2026-11-12", "", undefined]) {
      expect(() => parseTime(bad), String(bad)).toThrow(/not YYYY-MM-DDTHH:MM/);
    }
    expect(() => parseTime("2026-13-40T99:99")).toThrow(/not YYYY-MM-DDTHH:MM/);
    const p = plan();
    p.updated = "2026-11-12T11:40:00+02:00";
    const t0 = Date.now();
    expect(() => buildModel(p)).toThrow(/updated "2026-11-12T11:40:00\+02:00" is not YYYY-MM-DDTHH:MM/);
    expect(Date.now() - t0).toBeLessThan(1000);
    const q = plan();
    q.start = "12.11.2026 11:40";
    expect(() => buildModel(q)).toThrow(/start "12\.11\.2026 11:40"/);
  });
});

describe("verification level (W4.24)", () => {
  it("every task with a status has a known level and its PR, right after the status", () => {
    const p = plan();
    expect(checkVerified(p)).toEqual([]);
    for (const t of tasks(p)) {
      if (!t.status) {
        expect(t.verified, t.id).toBeUndefined();
        continue;
      }
      expect(VERIFIED_LEVELS, t.id).toContain(t.verified);
      expect(t.pr, t.id).toBe(prOf(t.status));
      const keys = Object.keys(t);
      expect(keys[keys.indexOf("status") + 1], t.id).toBe("verified");
    }
  });

  it("plan:check refuses an unknown level, a bad PR, a level without a status and the wrong key order", () => {
    const p = plan();
    // Open tasks, so the definition-of-done rules (plan 0.7) are not what fails.
    const [a, b, c, d] = tasks(p).filter((t) => t.status?.startsWith("⏳"));
    a.verified = "ci";
    b.pr = "#12" as unknown as number;
    const phaseOf = (t: Task) => p.phases.find((ph: { tasks: Task[] }) => ph.tasks.includes(t))!;
    // Moved to the end: no longer right after "status".
    const moved = { ...c };
    delete moved.verified;
    phaseOf(c).tasks[phaseOf(c).tasks.indexOf(c)] = { ...moved, verified: c.verified };
    const bare = { ...d };
    delete bare.status;
    phaseOf(d).tasks[phaseOf(d).tasks.indexOf(d)] = bare;
    const problems: string[] = checkVerified(p);
    expect(problems.some((x) => x.startsWith(`${a.id}: verified "ci" is not one of built, node, browser, real, owner`))).toBe(true);
    expect(problems.some((x) => x.startsWith(`${b.id}: pr "#12" is not a PR number`))).toBe(true);
    expect(problems.some((x) => x.startsWith(`${c.id}: verified, pr must come right after "status"`))).toBe(true);
    expect(problems.some((x) => x.startsWith(`${d.id}: verified and pr without a status`))).toBe(true);
    const dir = copy("verified-bad");
    writeFileSync(join(dir, "plan/plan.json"), JSON.stringify(p, null, 1) + "\n");
    expect(() => run({ root: dir, check: true })).toThrow(/verified \/ pr \(W4\.24\)/);
  });

  it("withVerified puts the two keys right after status and keeps every other key in place", () => {
    const t = { id: "9.9", title: "x", status: "⏳ #12", verified: "node", source: "s", pr: 3, steps: [] };
    expect(Object.keys(withVerified(t, "browser", 12))).toEqual(["id", "title", "status", "verified", "pr", "source", "steps"]);
    expect(withVerified(t, "browser", 12)).toMatchObject({ verified: "browser", pr: 12 });
    expect(Object.keys(withVerified(t, "built", undefined))).toEqual(["id", "title", "status", "verified", "source", "steps"]);
  });

  it("the board and the page show the level per task and the counts per level", () => {
    const p = plan();
    const M = buildModel(p);
    const counts = Object.fromEntries(VERIFIED_LEVELS.map((k: string) => [k, tasks(p).filter((t) => t.verified === k).length]));
    const board: string = renderBoard(M);
    const summary = VERIFIED_LEVELS.map((k: string) => `${VERIFIED_LABEL[k]} ${counts[k]}`).join(" · ");
    expect(board).toContain(`**רמת אימות (\`verified\`):** ${summary}`);
    expect(board).toContain("| מצב | אימות |");
    const t = tasks(p).find((x) => x.verified && x.pr)!;
    expect(board).toContain(`| ${VERIFIED_LABEL[t.verified!]} · [#${t.pr}](https://github.com/talstilkol/lumen-md/pull/${t.pr}) |`);
    const html: string = renderHtml(M);
    expect(html).toContain(`רמת אימות: ${summary}`);
    expect(html).toContain(`<span class="pill p-v p-v-${t.verified}">אימות: ${VERIFIED_LABEL[t.verified!]} · <a href="https://github.com/talstilkol/lumen-md/pull/${t.pr}">#${t.pr}</a></span>`);
  });

  it("the migration reads the level from the Hebrew status", () => {
    expect(prOf("⏳ #331 feat/vault-tasks (על #267)")).toBe(331);
    expect(prOf("✅ ביקורת עצמאית 10.11")).toBeUndefined();
    expect(classify("⏳ #331 (…) — נבדק רק ב-Node נקי; typecheck/vitest/build/Playwright ממתינים ל-Vercel Sandbox")).toBe("node");
    expect(classify("⏳ #388 (…; hebrewTts 37/37 ב-shim; לא נבדק ב-Sandbox (חסום עד 1.12); בעלים: tts:mos עם 5 מדרגים)")).toBe("node");
    expect(classify("⏳ #413 (whatsNew 6/6, דיאלוג 2/2 ב-Chromium; לא נבדק ב-Sandbox (חסום עד 1.12))")).toBe("browser");
    expect(classify("⏳ #369 (Vercel Sandbox (Node 24): typecheck 0, vitest 317/3047, e2e chromium+firefox 5/5; בעלים: חיבור Claude Desktop אמיתי, npm publish)")).toBe("owner");
    expect(classify("⏳ #487 (usabilityUnmoderated 8/8, Chromium עם OPFS 4/4; חסר: גיוס 12 משתתפים (טל))")).toBe("owner");
    // An owner item is not all that is owed: an agent's item sits next to it in "חסר".
    expect(classify("⏳ #484 (pagesLimits 5/5, Chromium 3/3; חסר: הפעלה (טל), ci:docker)")).toBe("browser");
    // A dod list names commands to run, not ones that ran.
    expect(classify("⏳ #381 (plain-Node 26/26; dod: npx vitest run a.test.ts · npx playwright test e2e/x.spec.ts --project=chromium)")).toBe("node");
    expect(classify("⏳ #366 (Vercel Sandbox (Node 24): typecheck 0, vitest 334/3395; אין e2e)")).toBe("node");
    expect(classify("⏳ #421 (npm run bench:models ב-Chromium אמיתי עם WebGPU; לא נבדק ב-Sandbox)")).toBe("built");
    expect(classify("⏳ #267 (מפרש נוסחאות; CI ירוק על 575b2ecf)")).toBe("browser");
    expect(classify("⏳ #307 feat/pii-redactor (CI אדום על בדיקות (צעד Test))")).toBe("built");
    expect(classify("✅ #202")).toBe("browser");
    expect(classify("✅* #241 (15/15 מקרי eval מול Ollama מזויף)")).toBe("owner");
  });

  it("the migration is idempotent and keeps a level set by hand unless asked to recompute", () => {
    const p = plan();
    expect(migrate(p).changed).toEqual([]);
    const t = tasks(p).find((x) => x.verified === "browser")!;
    t.verified = "real";
    expect(migrate(p).changed).toEqual([]);
    expect(migrate(p, { all: true }).changed).toEqual([t.id]);
  });

  it("a shortened status keeps its level: the migration reads the full text in notes (W10.G7)", () => {
    const one = { id: "9.9", status: "⏳ #5 קצר…", notes: "⏳ #5 (ארוך; vitest ב-Chromium 12/12)" };
    expect(classify(one.status)).toBe("built");
    const p = { phases: [{ tasks: [one] }] };
    expect(migrate(p, { all: true }).plan.phases[0].tasks[0].verified).toBe("browser");
  });
});

describe("honest statuses (W10.G7, W10.G8, W10.G12)", () => {
  const one = (t: Record<string, unknown>) => ({ phases: [{ title: "x", tasks: [{ id: "9.9", title: "t", lane: "D", minutes: 10, priority: "P1", steps: [], acceptance: [], ...t }] }] });

  it("✅ needs a browser or real check: built, node and owner are refused (W10.G8)", () => {
    for (const verified of ["built", "node", "owner", undefined]) {
      expect(checkDoneLevel(one({ status: "✅ #1", verified }))[0], String(verified)).toMatch(/9\.9: marked ✅ but verified .* needs browser or real/);
    }
    expect(checkDoneLevel(one({ status: "✅* #1", verified: "owner" }))[0]).toMatch(/marked ✅\*/);
    expect(checkDoneLevel(one({ status: "✅ #1", verified: "browser" }))).toEqual([]);
    expect(checkDoneLevel(one({ status: "✅ #1", verified: "real" }))).toEqual([]);
    expect(checkDoneLevel(one({ status: "⏳ #1", verified: "built" }))).toEqual([]);
    expect(checkDoneLevel(plan())).toEqual([]);
  });

  it("a status is at most 200 characters; the detail goes in notes (W10.G7)", () => {
    expect(STATUS_MAX).toBe(200);
    expect(checkStatusLength(one({ status: "⏳ " + "א".repeat(198) }))).toEqual([]);
    expect(checkStatusLength(one({ status: "⏳ " + "א".repeat(199) }))[0]).toMatch(/9\.9: status is 201 characters, over 200/);
    expect(checkStatusLength(one({ status: "⏳", notes: " " }))[0]).toMatch(/notes must be a non-empty string/);
    expect(checkStatusLength(plan())).toEqual([]);
  });

  it("plan:check fails on a long status or a ✅ below browser in the checked-in files", () => {
    const dir = copy("honest");
    const p = plan();
    const t = tasks(p).find((x) => x.id === "0.6")! as Task & { verified?: string };
    t.verified = "node";
    writeFileSync(join(dir, "plan/plan.json"), JSON.stringify(p, null, 1) + "\n");
    expect(() => run({ root: dir, check: true })).toThrow(/0\.6: marked ✅ but verified "node"/);
    t.verified = "browser";
    t.status = "⏳ " + "ב".repeat(STATUS_MAX);
    writeFileSync(join(dir, "plan/plan.json"), JSON.stringify(p, null, 1) + "\n");
    expect(() => run({ root: dir, check: true })).toThrow(/0\.6: status is \d+ characters/);
  });

  it("notes are shown under the task on the board and the page, never as \"undefined\"", () => {
    const p = plan();
    const t = tasks(p).find((x) => x.notes) as (Task & { notes?: string }) | undefined;
    expect(t, "some task keeps its long status in notes").toBeDefined();
    const M = buildModel(p);
    const board = renderBoard(M);
    const html = renderHtml(M);
    expect(board).toContain(`**פירוט הסטטוס:** ${t!.notes}`);
    expect(html).toContain("פירוט הסטטוס:");
    // a task without a branch and a phase without a goal used to print the word "undefined"
    expect(board).not.toContain("undefined");
    expect(html).not.toContain("undefined");
  });

  it("wave 10 is in the plan, every task once, with a status and a known lane (W10.G12)", () => {
    const p = plan();
    const w10 = p.phases.find((ph: { title: string }) => ph.title === "גל 10 — השלמה כנה לפי ביקורת הקוד");
    expect(w10).toBeDefined();
    expect(w10.tasks).toHaveLength(241);
    const ids = tasks(p).map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const x of w10.tasks) {
      expect(x.id, x.id).toMatch(/^W10\.[A-Z]\d+$/);
      expect(x.status, x.id).toBeTruthy();
      expect(Object.keys(p.lanes), x.id).toContain(x.lane);
    }
  });
});

describe("work-in-progress limit (plan W6.39)", () => {
  type T = { id: string; status?: string; verified?: string };
  const wave = (n: number, ts: T[]) => ({ title: `גל ${n} — x`, tasks: ts });
  const mini = (w1: T[], w2: T[], schedule: Record<string, unknown> = {}) => ({ schedule, phases: [{ title: "יסודות", tasks: [{ id: "0.1", status: "⏳" }] }, wave(1, w1), wave(2, w2)] });
  const w1: T[] = [
    { id: "W1.1", status: "⏳ #1" },
    { id: "W1.2", status: "⏳ #2", verified: "node" },
    { id: "W1.3", status: "⏳ #3", verified: "browser" },
    { id: "W1.4", status: "✅ #4" },
    { id: "W1.5" },
  ];

  it("reads waves from phase titles and counts ⏳ below browser (no level = below)", () => {
    expect([waveNumber("גל 6 — תיקונים"), waveNumber("יסודות ואוטומציה"), waveNumber(" גל 12 — x")]).toEqual([6, null, 12]);
    expect(w1.map((t) => belowFloor(t))).toEqual([true, true, false, false, false]);
    expect(belowFloor({ status: "⏳", verified: "real" })).toBe(false);
    expect(belowFloor({ status: "⏳", verified: "owner" })).toBe(false);
    expect(WIP_LIMIT).toBe(5);
  });

  it("a new task of the next wave is flagged while the wave before is over the limit", () => {
    const quiet = mini(w1, [{ id: "W2.1" }, { id: "W2.2" }]);
    expect(wipWarnings(quiet, { limit: 1 })).toEqual([]);
    // W2.1 starts: now it is a warning (and --wip-strict fails the check).
    const started = mini(w1, [{ id: "W2.1", status: "⏳ #9" }, { id: "W2.2" }]);
    const [w] = wipWarnings(started, { limit: 1 });
    expect(w).toEqual({ wave: 1, next: 2, limit: 1, open: ["W1.1", "W1.2"], unlabelled: 1, started: ["W2.1"] });
    expect(formatWip(w)).toBe("plan: WIP — wave 1 has 2 ⏳ tasks verified below browser (limit 1; 1 with no verified level) while wave 2 has 1 started (W2.1). Verify wave 1 first: W1.1, W1.2.");
    // At the limit is fine; plan.schedule.wipLimit sets it when no limit is passed.
    expect(wipWarnings(started, { limit: 2 })).toEqual([]);
    expect(wipWarnings(mini(w1, [{ id: "W2.1", status: "⏳" }], { wipLimit: 2 }))).toEqual([]);
    expect(wipWarnings(mini(w1, [{ id: "W2.1", status: "⏳" }], { wipLimit: 1 }))).toHaveLength(1);
    // Verifying the wave lifts it.
    const verified = mini(w1.map((t) => (t.status?.startsWith("⏳") ? { ...t, verified: "browser" } : t)), [{ id: "W2.1", status: "⏳" }]);
    expect(wipWarnings(verified, { limit: 0 })).toEqual([]);
  });

  it("run() reports the warnings; the CLI only warns unless --wip-strict", () => {
    const p = plan();
    expect(run({ root: ROOT, check: true, wipLimit: 3 }).wip).toEqual(wipWarnings(p, { limit: 3 }));
    const cli = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, "scripts/plan/build.mjs"), "--check", ...args], { cwd: ROOT, encoding: "utf8" });
    const loose = cli("--wip-limit", "0");
    expect(loose.status).toBe(0);
    expect(loose.stderr.split("\n").filter((l) => l.startsWith("plan: WIP")).length).toBe(wipWarnings(p, { limit: 0 }).length);
    expect(cli("--wip-limit", "0", "--wip-strict").status).toBe(wipWarnings(p, { limit: 0 }).length ? 1 : 0);
    expect(cli("--wip-limit", "100000", "--wip-strict").status).toBe(0);
    expect(cli("--wip-limit", "x").status).toBe(1);
  });
});

describe("work in progress: what counts as started (W10.G6)", () => {
  it("a wave's placeholder status is not started; real work is", () => {
    expect(isStarted({ status: "⏳ גל 10 — לא התחיל" })).toBe(false);
    expect(isStarted({ status: "⏳ גל 11 — לא התחיל (מחכה ל-W10.Z1)" })).toBe(false);
    expect(isStarted({ status: "" })).toBe(false);
    expect(isStarted({})).toBe(false);
    expect(isStarted({ status: "⏳ #618 — בעבודה" })).toBe(true);
    expect(isStarted({ status: "✅ #1" })).toBe(true);
    const wave = (n: number, tasks: object[]) => ({ title: `גל ${n} — x`, tasks });
    const open = Array.from({ length: 6 }, (_, i) => ({ id: `W1.${i}`, status: "⏳ #1", verified: "built" }));
    const placeholder = { phases: [wave(1, open), wave(2, [{ id: "W2.1", status: "⏳ גל 2 — לא התחיל" }])] };
    expect(wipWarnings(placeholder)).toEqual([]);
    const started = { phases: [wave(1, open), wave(2, [{ id: "W2.1", status: "⏳ #9 בעבודה" }])] };
    expect(wipWarnings(started)).toHaveLength(1);
  });
});
