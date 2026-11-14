/** K1 — eval baselines: a case that passed and now fails is a regression. */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROMPT_CASES } from "../agents/eval/promptCases";
import { PROMPTS } from "../ai/prompts";

const script = join(__dirname, "../../scripts/eval-compare.mjs");
const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
const results = (ok: Record<string, boolean>) => ({ model: "m", date: "2026-10-18", results: Object.entries(ok).map(([id, v]) => ({ id, status: "ok", checks: [{ ok: v }] })) });

describe("eval baseline compare", () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-"));
  const base = join(dir, "base.json");
  const now = join(dir, "agents-2026-10-18-m.json");

  it("saves a baseline, then flags a regression and reports fixes", () => {
    writeFileSync(now, JSON.stringify(results({ a: true, b: false })));
    expect(run([now, "--save", "--baseline", base]).status).toBe(0);
    expect(JSON.parse(readFileSync(base, "utf8")).results).toHaveLength(2);
    writeFileSync(now, JSON.stringify(results({ a: false, b: true })));
    const r = run([now, "--baseline", base]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("REGRESSIONS: a");
    expect(r.stdout).toContain("fixed: b");
  });

  it("a passing baseline case that is gone from the run fails; a skipped one does not", () => {
    writeFileSync(base, JSON.stringify(results({ a: true, b: true })));
    writeFileSync(now, JSON.stringify(results({ a: true })));
    const r = run([now, "--baseline", base]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("MISSING (passed in the baseline, not in this run): b");
    const skipped = { ...results({ a: true }), results: [...results({ a: true }).results, { id: "b", status: "skipped" }] };
    writeFileSync(now, JSON.stringify(skipped));
    expect(run([now, "--baseline", base]).status).toBe(0);
  });

  it("refuses to compare a fake-server (wiring) run with a real-model baseline, and the reverse", () => {
    writeFileSync(base, JSON.stringify({ ...results({ a: true }), model: "fake-ollama", kind: "wiring" }));
    writeFileSync(now, JSON.stringify({ ...results({ a: true }), model: "qwen2.5:7b", kind: "model" }));
    const r = run([now, "--baseline", base]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("refusing to compare");
    writeFileSync(base, JSON.stringify(results({ a: true })));
    writeFileSync(now, JSON.stringify({ ...results({ a: true }), model: "fake-ollama" }));
    expect(run([now, "--baseline", base]).status).toBe(2);
  });

  it("the committed baselines say they are wiring runs of the fake server", () => {
    for (const f of ["agents-fake.json", "prompts-fake.json"]) {
      const b = JSON.parse(readFileSync(join(__dirname, "../../eval/baseline", f), "utf8"));
      expect(b.model).toBe("fake-ollama");
      expect(b.kind).toBe("wiring");
    }
  });

  it("no regressions → exit 0", () => {
    writeFileSync(now, JSON.stringify(results({ a: true, b: false })));
    writeFileSync(base, JSON.stringify(results({ a: true, b: false })));
    expect(run([now, "--baseline", base]).status).toBe(0);
  });
});

describe("prompt eval cases", () => {
  it("cover the prompts that answer users, Hebrew included", () => {
    const covered = new Set(PROMPT_CASES.map((c) => c.prompt));
    for (const p of ["rewrite", "autocomplete", "ragAssistant", "summarize", "actionItems", "commitMessage", "translate"] as const) expect(covered.has(p)).toBe(true);
    expect(PROMPT_CASES.filter((c) => c.id.endsWith("-he")).length).toBeGreaterThanOrEqual(4);
  });
  it("user-facing prompts ask for the user's language (K2)", () => {
    for (const k of ["rewrite", "autocomplete", "ragAssistant", "summarize", "actionItems", "ghostwriter"] as const) expect(PROMPTS[k]).toMatch(/same language/);
  });
  it("the checks reject an English answer to a Hebrew request", () => {
    const c = PROMPT_CASES.find((x) => x.id === "rewrite-he")!;
    const lang = c.checks.find((k) => k.name === "same language")!;
    expect(lang.test("The meeting tomorrow moved to three because the client cannot make the morning, please update everyone.", c.user)).toBe(false);
    expect(lang.test("הפגישה שנקבעה למחר נדחתה לשעה שלוש, מאחר שהלקוח אינו פנוי בבוקר. נא לעדכן את כל המשתתפים.", c.user)).toBe(true);
  });
  it("a short wrong-language autocomplete fails; the summary needs exactly two bullets", () => {
    const ac = PROMPT_CASES.find((x) => x.id === "autocomplete-he")!;
    const lang = ac.checks.find((k) => k.name === "same language")!;
    expect(lang.test("more tests", ac.user)).toBe(false);
    expect(lang.test("הגרסה הבאה", ac.user)).toBe(true);
    const sum = PROMPT_CASES.find((x) => x.id === "summarize-he")!;
    const two = sum.checks.find((k) => k.name === "two bullets")!;
    expect(two.test("- אחד\n- שניים", sum.user)).toBe(true);
    expect(two.test("- אחד", sum.user)).toBe(false);
    expect(two.test("- אחד\n- שניים\n- שלושה", sum.user)).toBe(false);
  });
  it("the translation case checks the target language and the Markdown", () => {
    const c = PROMPT_CASES.find((x) => x.prompt === "translate")!;
    const all = (o: string) => c.checks.every((k) => k.test(o, c.user));
    expect(all("# Weekly summary\n\nThe launch moved to Tuesday. See [the plan](plan.md).\n\n- Check the budget")).toBe(true);
    expect(all("# סיכום שבועי\n\nההשקה נדחתה. [התוכנית](plan.md)\n\n- לבדוק")).toBe(false);
  });
});
