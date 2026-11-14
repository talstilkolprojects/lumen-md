import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isGateRun, missingToolVerdict } from "../../e2e/_gate";

/**
 * Plan 3.7: the data-safety P0 matrix. Every data-loss path G1–G11 has an
 * e2e scenario. A scenario is a Playwright test whose title starts with its
 * G ids ("G5, G6: …"). G8 (sync providers) lives with the providers
 * (plan 3.5, e2e/sync-providers.spec.ts); it counts when that spec exists.
 *
 * What this file proves, and what it does not (audit 3.7, plan W10.B17):
 * it reads test titles, so it shows the matrix is *defined*. It cannot show
 * a scenario *passes*; only the e2e run does that, in the three browsers
 * (chromium and firefox on the gate, webkit on the Mac). No result here is
 * a data-safety pass.
 */
const root = join(__dirname, "..", "..");
const read = (p: string) => {
  try {
    return readFileSync(join(root, p), "utf8");
  } catch {
    return "";
  }
};

function coveredIds(src: string): Set<string> {
  const ids = new Set<string>();
  for (const m of src.matchAll(/^test\("((?:G\d+(?:, )?)+):/gm)) for (const id of m[1].split(", ")) ids.add(id);
  return ids;
}

/** The body of the test whose title starts with `id:`, up to the next top-level test. */
function scenarioBody(src: string, id: string): string {
  const start = src.search(new RegExp(`^test\\("${id}:`, "m"));
  if (start < 0) return "";
  const rest = src.slice(start + 1);
  const next = rest.search(/^test(?:\.\w+)?\(/m);
  return next < 0 ? rest : rest.slice(0, next);
}

const spec = read("e2e/data-safety.spec.ts");

describe("data-safety matrix is defined (plan 3.7): titles only, the e2e run proves it passes", () => {
  const ids = coveredIds(spec);
  const providers = read("e2e/sync-providers.spec.ts");
  if (/\bG8\b/.test(providers)) ids.add("G8");

  for (const n of [1, 2, 3, 4, 5, 6, 7, 9, 10, 11]) {
    it(`G${n} is defined as an e2e scenario in e2e/data-safety.spec.ts`, () => {
      expect(ids.has(`G${n}`)).toBe(true);
    });
  }

  it("G8 is defined only once the plan 3.5 provider e2e is merged in", () => {
    // Plan 3.7.1: G8 stays open (and the P0 gate with it) until 3.5 connects
    // the providers and runs G8 on the user's path.
    expect(ids.has("G8")).toBe(providers.length > 0);
  });
});

describe("G3 is not skipped silently on the gate (plan W10.B17, audit 3.7)", () => {
  it("a missing tool skips a local run and fails the gate", () => {
    expect(missingToolVerdict(true, {})).toBe("run");
    expect(missingToolVerdict(true, { CI: "true" })).toBe("run");
    expect(missingToolVerdict(false, {})).toBe("skip");
    expect(missingToolVerdict(false, { CI: "true" })).toBe("fail");
    expect(missingToolVerdict(false, { LUMEN_CI: "buildkite" })).toBe("fail");
    expect(missingToolVerdict(false, { LUMEN_GATE: "1" })).toBe("fail");
  });

  it("only a set, non-false variable makes a run the gate", () => {
    expect(isGateRun({ CI: "" })).toBe(false);
    expect(isGateRun({ CI: "0" })).toBe(false);
    expect(isGateRun({ CI: "false" })).toBe(false);
    expect(isGateRun({ CI: "1" })).toBe(true);
  });

  it("the Buildkite pipeline sets LUMEN_CI, so its e2e jobs count as the gate", () => {
    const pipeline = read(".buildkite/pipeline.yml");
    const m = pipeline.match(/^\s+LUMEN_CI:\s*"?([^"\n]+)"?/m);
    expect(m, "LUMEN_CI in .buildkite/pipeline.yml").not.toBeNull();
    expect(isGateRun({ LUMEN_CI: m![1] })).toBe(true);
  });

  it("G3 decides with missingToolVerdict and throws on 'fail' before it can skip", () => {
    const body = scenarioBody(spec, "G3");
    expect(body).not.toBe("");
    const verdictAt = body.indexOf("missingToolVerdict(");
    const throwAt = body.search(/if \(backendVerdict === "fail"\)\s*\{\s*throw new Error\(/);
    const skipAt = body.search(/test\.skip\(backendVerdict === "skip"/);
    expect(verdictAt).toBeGreaterThan(-1);
    expect(throwAt).toBeGreaterThan(verdictAt);
    expect(skipAt).toBeGreaterThan(throwAt);
    // No other skip on the http-backend check.
    expect(body).not.toMatch(/test\.skip\([^)]*\.error !== undefined/);
  });
});
