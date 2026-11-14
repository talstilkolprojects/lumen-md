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
import { checkSeams, deadSeams, LIVE_SEAM_EXCEPTIONS } from "../../scripts/lib/liveSeams.mjs";

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
    const { problems } = checkSeams(dir, {
      setA: { kind: "pending", reason: "x" },
      setB: { kind: "pending", task: "W10.C8", reason: "x" },
      setGone: { kind: "test-only", reason: "x" },
      setC: { kind: "test-only", reason: "a knob" },
    });
    expect(problems.map((p: { name: string; rule: string }) => `${p.rule}:${p.name}`).sort()).toEqual(["dead-seam:setA", "live-seam-stale:setB", "live-seam-stale:setGone"]);
  });

  it("this tree: every dead seam is listed with its reason, and no entry is stale", () => {
    const { problems, dead } = checkSeams(join(process.cwd(), "src"));
    expect(problems).toEqual([]);
    expect(names(dead)).toEqual(Object.keys(LIVE_SEAM_EXCEPTIONS).sort());
    for (const [name, e] of Object.entries(LIVE_SEAM_EXCEPTIONS as Record<string, { kind: string; task?: string; reason: string }>)) {
      expect(["pending", "test-only", "dead"], name).toContain(e.kind);
      expect(e.reason.length, name).toBeGreaterThan(5);
      if (e.kind === "pending") expect(e.task, name).toMatch(/^W\d+\.\w+$/);
    }
  });

  it("npm run hygiene runs the gate", () => {
    expect(JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).scripts.hygiene).toContain("node scripts/check-live-seams.mjs");
  });
});
