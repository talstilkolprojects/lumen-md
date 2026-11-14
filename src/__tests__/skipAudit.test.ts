import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain .mjs module without type declarations
import { auditSkips, findSkips, MAX_E2E_SKIPS, parseAnnotation } from "../../scripts/lib/skipAudit.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { classify, vaultGatedTests } from "../../scripts/skip-report.mjs";

type Site = { line: number; call: string; condition: string; annotation: string | null; problems: string[] };
const TODAY = new Date(Date.UTC(2026, 10, 12));
const sites = (src: string, file = "e2e/x.spec.ts"): Site[] => findSkips(file, src, TODAY);
const REASON = "// skip-reason: Playwright's WebKit has no OPFS here | task: 0.5 | until: 2027-05-12";
const ROOT = join(__dirname, "..", "..");

describe("skip audit (plan W4.12)", () => {
  it("fails a planted skip without a reason, in every form the runners have", () => {
    const found = sites(
      [
        'test.skip(!ok, "no vault");',
        'test.describe.fixme("later", () => {});',
        'describe.skipIf(!model)("eval", () => {});',
        'it.runIf(process.env.X)("only with X", () => {});',
        'it.todo("max lines");',
        "test.skip();",
      ].join("\n"),
    );
    expect(found.map((s) => s.call)).toEqual(["test.skip", "test.describe.fixme", "describe.skipIf", "it.runIf", "it.todo", "test.skip"]);
    expect(found.every((s) => s.problems.length === 1 && /no `\/\/ skip-reason:/.test(s.problems[0]))).toBe(true);
  });

  it("accepts a complete reason on the line, above it, or continued over comment lines", () => {
    expect(sites(`test.skip(!ok, "x"); ${REASON}`)[0].problems).toEqual([]);
    expect(sites(`${REASON}\ntest.skip(!ok, "x");`)[0].problems).toEqual([]);
    const long = sites("  // skip-reason: a long reason that goes on\n  // over a second line | task: W4.12 | until: 2027-01-01\n  test.skip(dev, 'x');")[0];
    expect(long.problems).toEqual([]);
    expect(long.annotation).toContain("over a second line");
  });

  it("does not count the words in strings, comments or other calls", () => {
    const src = ['const s = "test.skip(!ok)";', "// test.skip(!ok, 'commented out')", "t.skip(); onboard.skip(); skip();", "page.getByText('Skip setup');"].join("\n");
    expect(sites(src)).toEqual([]);
  });

  it("a reason needs a task and a date that is neither past nor more than a year away", () => {
    expect(parseAnnotation("short", TODAY).problems).toHaveLength(3);
    expect(parseAnnotation("a reason that is long enough | until: 2027-01-01", TODAY).problems).toEqual([expect.stringMatching(/no task/)]);
    expect(parseAnnotation("a reason that is long enough | task: W4.12", TODAY).problems).toEqual([expect.stringMatching(/no review date/)]);
    expect(parseAnnotation("a reason that is long enough | task: W4.12 | until: 2027-02-30", TODAY).problems).toEqual([expect.stringMatching(/no review date/)]);
    expect(parseAnnotation("a reason that is long enough | task: #431 | until: 2026-11-11", TODAY).problems).toEqual([expect.stringMatching(/has passed/)]);
    expect(parseAnnotation("a reason that is long enough | task: 0.5 | until: 2026-11-12", TODAY).problems).toEqual([]);
    expect(parseAnnotation("a reason that is long enough | task: 0.5 | until: 2028-01-01", TODAY).problems).toEqual([expect.stringMatching(/more than 366 days/)]);
  });

  it(`e2e/ holds at most ${MAX_E2E_SKIPS} skips, annotated or not`, () => {
    const dir = mkdtempSync(join(tmpdir(), "skip-audit-"));
    try {
      mkdirSync(join(dir, "e2e"));
      const body = (n: number) => Array.from({ length: n }, (_, i) => `${REASON}\ntest.skip(!ok${i}, "x");`).join("\n");
      writeFileSync(join(dir, "e2e", "a.spec.ts"), body(MAX_E2E_SKIPS));
      expect(auditSkips(dir, { today: TODAY }).violations).toEqual([]);
      writeFileSync(join(dir, "e2e", "a.spec.ts"), body(MAX_E2E_SKIPS + 1));
      const r = auditSkips(dir, { today: TODAY });
      expect(r.e2eCount).toBe(MAX_E2E_SKIPS + 1);
      expect(r.violations.map((v: { rule: string }) => v.rule)).toEqual(["skip-count"]);
      // A planted skip without a reason fails on its own line.
      writeFileSync(join(dir, "e2e", "a.spec.ts"), `test("x", async ({ page }) => {\n  test.skip(!(await seed(page)), "no vault");\n});\n`);
      expect(auditSkips(dir, { today: TODAY }).violations).toEqual([{ file: "e2e/a.spec.ts", line: 2, rule: "skip-reason", text: expect.stringMatching(/^test\.skip: no `\/\/ skip-reason:/) }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the repository passes: every skip has a reason, and e2e/ is within the cap", () => {
    const r = auditSkips(ROOT);
    expect(r.violations).toEqual([]);
    expect(r.e2eCount).toBeLessThanOrEqual(MAX_E2E_SKIPS);
  });

  it("the report sorts skips by what they leave out, and lists the vault flows WebKit does not run", () => {
    expect(classify({ call: "it.todo", condition: "" })).toBe("deferred");
    expect(classify({ call: "test.skip", condition: 'browserName !== "chromium"' })).toBe("engine");
    expect(classify({ call: "test.skip", condition: "!process.env.OCR_CER" })).toBe("setup");
    const gated = vaultGatedTests(join(ROOT, "e2e")) as Array<{ file: string; title: string }>;
    expect(gated.length).toBeGreaterThan(20);
    expect(gated).toContainEqual({ file: "e2e/data-safety.spec.ts", title: "G7: the whole vault exports as a zip" });
  });
});
