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
  // @ts-expect-error — plain .mjs script without type declarations
} from "../../scripts/plan/build.mjs";

const ROOT = resolve(__dirname, "..", "..");
const plan = () => JSON.parse(readFileSync(join(ROOT, "plan/plan.json"), "utf8"));
const tmp = mkdtempSync(join(tmpdir(), "lumen-plan-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A copy of the plan, the document and the page. */
function copy(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(join(dir, "plan"), { recursive: true });
  mkdirSync(join(dir, "public"), { recursive: true });
  for (const f of ["plan/plan.json", "plan/board.html", "public/roadmap.html", "MASTER_PLAN.md"]) cpSync(join(ROOT, f), join(dir, f));
  return dir;
}
type Task = { id: string; status?: string; priority: string; dep?: string[] };
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
    expect(run({ root: dir, check: true }).stale).toEqual(["MASTER_PLAN.md", "plan/board.html", "public/roadmap.html"]);
    expect(run({ root: dir }).stale.length).toBe(3);
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
    const lane = M.agent.filter((t: { lane: string; done?: boolean }) => t.lane === release.lane && !t.done);
    const before = lane.filter((t: { eff: string; end: number }) => t.eff !== "P0" && t.end <= release.start);
    expect(before.length).toBeGreaterThan(0);
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
});
