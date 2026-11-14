/**
 * The live-seam gate (coordinator decision R4.1): a register… or set… hook only
 * tests call fails `npm run hygiene`, unless LIVE_SEAM_EXCEPTIONS names it
 * with its reason; an entry whose seam is live again fails too.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain .mjs script without type declarations
import { checkSeams, deadSeams, entryProblems, loadAllowList, LIVE_SEAM_EXCEPTIONS, MAX_ALLOW_DAYS } from "../../scripts/lib/liveSeams.mjs";
import { spawnSync } from "node:child_process";

type Seam = { name: string; file: string };
let tmp: string | null = null;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});
function src(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "seams-"));
  tmp = dir;
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), t);
  }
  return dir;
}
const names = (xs: Seam[]) => xs.map((x) => x.name).sort();

describe("live seams", () => {
  it("a hook only tests call is dead; a production call, not a comment or a re-export, makes it live", () => {
    const dir = src({
      "ai/engine.ts": "export function setEngine(e: unknown) {}\nexport function registerRanker(r: unknown) {}\nexport const setModel = (m: unknown) => {};\nexport async function setLive() {}",
      "ai/index.ts": 'export { setEngine } from "./engine";\n// registerRanker(x) is called by the app one day\n/* setModel(y) */',
      "__tests__/engine.test.ts": 'import { setEngine, registerRanker, setModel } from "../ai/engine";\nsetEngine(1); registerRanker(2); setModel(3);',
      "ai/engine.stories.tsx": 'import { setModel } from "./engine"; setModel(1);',
      "App.tsx": 'import { setLive } from "./ai/engine";\nvoid setLive();',
    });
    const { seams, dead } = deadSeams(dir);
    expect(names(seams)).toEqual(["registerRanker", "setEngine", "setLive", "setModel"]);
    expect(names(dead)).toEqual(["registerRanker", "setEngine", "setModel"]);
    expect(checkSeams(dir, {}).problems.map((p: { name: string; rule: string }) => `${p.rule}:${p.name}`).sort()).toEqual(["dead-seam:registerRanker", "dead-seam:setEngine", "dead-seam:setModel"]);
  });

  it("an exception needs its task when pending, and goes when the seam is live or gone", () => {
    const dir = src({ "a.ts": "export function setA() {}\nexport function setB() {}\nsetB();", "b.ts": "export function setC() {}" });
    const ok = { task: "W11.I1", expires: "2026-12-31" };
    const { problems } = checkSeams(
      dir,
      {
        setA: { kind: "pending", reason: "x wired later", expires: "2026-12-31" },
        setB: { kind: "pending", task: "W10.C8", reason: "x wired later", expires: "2026-12-31" },
        setGone: { kind: "test-only", reason: "a knob for tests", ...ok },
        setC: { kind: "test-only", reason: "a knob for tests", ...ok },
      },
      { today: "2026-11-14" },
    );
    expect(problems.map((p: { name: string; rule: string }) => `${p.rule}:${p.name}`).sort()).toEqual(["live-seam-allow:setA", "live-seam-stale:setB", "live-seam-stale:setGone"]);
  });

  it("an orphan seam planted in a fixture fails the gate", () => {
    const dir = src({ "ai/live.ts": "export function setUsed() {}\n", "App.tsx": 'import { setUsed } from "./ai/live"; setUsed();', "ai/orphan.ts": "export function registerOrphanEngine(e: unknown) {}\n" });
    const r = checkSeams(dir, {}, { today: "2026-11-14" });
    expect(r.problems.map((p: { rule: string; name: string; file: string }) => [p.rule, p.name, p.file])).toEqual([["dead-seam", "registerOrphanEngine", "ai/orphan.ts"]]);
  });

  it("an expired allow-list entry fails the gate, on its expiry day and after", () => {
    const dir = src({ "a.ts": "export function setLater() {}\n" });
    const allow = { setLater: { kind: "pending", task: "W10.C8", reason: "wired by the capture task", expires: "2026-11-20" } };
    expect(checkSeams(dir, allow, { today: "2026-11-19" }).problems).toEqual([]);
    for (const today of ["2026-11-20", "2027-01-01"]) {
      const { problems } = checkSeams(dir, allow, { today });
      expect(problems).toHaveLength(1);
      expect(problems[0].rule).toBe("live-seam-allow");
      expect(problems[0].text).toContain("expired on 2026-11-20");
    }
  });

  it("every entry needs a task, a reason and an expiry at most MAX_ALLOW_DAYS ahead", () => {
    const today = "2026-11-14";
    expect(entryProblems("s", { kind: "test-only", reason: "a knob for tests", expires: "2026-12-01" }, today)).toEqual(["s: an allow-list entry needs the plan task that closes it"]);
    expect(entryProblems("s", { kind: "dead", task: "W11.I1", reason: "nothing calls it" }, today)).toEqual(["s: an allow-list entry needs an expiry date (YYYY-MM-DD)"]);
    expect(entryProblems("s", { kind: "dead", task: "W11.I1", reason: "", expires: "2026-12-01" }, today)).toEqual(["s: an allow-list entry needs its reason"]);
    expect(entryProblems("s", { kind: "dead", task: "W11.I1", reason: "nothing calls it", expires: "2099-01-01" }, today)[0]).toContain(`more than ${MAX_ALLOW_DAYS} days ahead`);
    expect(entryProblems("s", { kind: "maybe", task: "W11.I1", reason: "nothing calls it", expires: "2026-12-01" }, today)).toEqual(["s: kind must be pending, test-only or dead"]);
  });

  it("this tree: every dead seam is listed with its reason, and no entry is stale", () => {
    const { problems, dead } = checkSeams(join(process.cwd(), "src"));
    expect(problems).toEqual([]);
    expect(names(dead)).toEqual(Object.keys(LIVE_SEAM_EXCEPTIONS).sort());
    for (const [name, e] of Object.entries(LIVE_SEAM_EXCEPTIONS as Record<string, { kind: string; task?: string; reason: string }>)) {
      expect(["pending", "test-only", "dead"], name).toContain(e.kind);
      expect(e.reason.length, name).toBeGreaterThan(5);
      expect(e.task, name).toMatch(/^W\d+\.\w+$/);
    }
    expect(LIVE_SEAM_EXCEPTIONS).toEqual(loadAllowList(join(process.cwd(), "scripts/seams.allow.json")));
  });

  it("npm run hygiene, check and check:seams run the gate, and ci:local runs hygiene", () => {
    const scripts = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).scripts;
    expect(scripts.hygiene).toContain("node scripts/check-live-seams.mjs");
    expect(scripts["check:seams"]).toBe("node scripts/check-live-seams.mjs");
    expect(scripts.check).toContain("hygiene");
    expect(readFileSync(join(process.cwd(), "scripts/lib/ciLocal.mjs"), "utf8")).toMatch(/id: "hygiene"[^\n]*"run", "-s", "hygiene"/);
  });

  it("the gate exits 0 on this tree in under 5 seconds", () => {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [join(process.cwd(), "scripts/check-live-seams.mjs")], { encoding: "utf8" });
    const ms = Date.now() - t0;
    expect(r.status, r.stderr).toBe(0);
    expect(ms).toBeLessThan(5000);
  });
});
