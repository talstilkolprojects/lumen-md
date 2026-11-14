/**
 * The formulator agent (plan 4.11): a formula from a plain-language
 * description, checked by the formula parser. A fake executor stands in for
 * the local model; the real-model run is the eval case `formulator-he`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => ({ aiKey: null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null }) } }));
vi.mock("../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));

import { registerExecutor, resetExecutors } from "../agents/executors";
import { runAgent } from "../agents/runtime";
import { cleanFormula, formulaFields, formulatorAgent, type FormulatorInput } from "../agents/defs";
import { parseFormulaOrThrow } from "../views/formula";
import { fakeExecutor, sequence } from "./helpers/fakeExecutor";

const INPUT: FormulatorInput = {
  text: "כמה ימים נשארו עד היעד",
  extra: { fields: [{ name: "יעד", example: "2026-11-01" }, { name: "סטטוס", example: "הושלם" }, { name: "price" }] },
};

beforeEach(() => {
  resetExecutors();
  localStorage.setItem("lumen.ai.cache", "off");
});

describe("formulator helpers", () => {
  it("cleanFormula keeps one line without fences, prefixes or backticks", () => {
    expect(cleanFormula("```\nprice * 2\n```")).toBe("price * 2");
    expect(cleanFormula("Formula: `datediff(יעד, today())`")).toBe("datediff(יעד, today())");
    expect(cleanFormula("= price + 1\nexplanation")).toBe("price + 1");
    expect(cleanFormula("\n\n  נוסחה: price\n")).toBe("price");
  });

  it("only file.name / path / folder are the note's own", () => {
    expect(formulaFields(parseFormulaOrThrow("file.name & file.folder"))).toEqual([]);
    expect(formulaFields(parseFormulaOrThrow("file.title"))).toEqual(["file"]);
  });

  it("formulaFields lists the properties a formula reads", () => {
    expect(formulaFields(parseFormulaOrThrow('if(סטטוס = "x", price * qty, prop("due date")) & file.name & meta.owner'))).toEqual(["סטטוס", "price", "qty", "due date", "meta"]);
  });
});

describe("formulator agent (fake executor)", () => {
  it("an answer that does not parse goes back with the parser's message; the retry is used", async () => {
    const ex = fakeExecutor(sequence("datediff(יעד, today()", "```\ndatediff(יעד, today())\n```"));
    registerExecutor(ex);
    const run = await runAgent(formulatorAgent, INPUT);
    expect(run.status).toBe("ok");
    expect(run.output).toBe("datediff(יעד, today())");
    expect(ex.calls).toHaveLength(2);
    expect(ex.calls[1].messages.map((m) => m.content).join("\n")).toMatch(/does not parse/);
    // The prompt lists the properties with examples, and the function table.
    expect(ex.calls[0].messages[1].content).toContain("- יעד (e.g. 2026-11-01)");
    expect(ex.calls[0].messages[0].content).toContain("datediff");
  });

  it("an unknown property or function is rejected", async () => {
    const ex = fakeExecutor(sequence("deadline - today()", "eval(price)", "price * 2"));
    registerExecutor(ex);
    const run = await runAgent(formulatorAgent, INPUT);
    expect(run.output).toBe("price * 2");
    const steps = run.steps.filter((s) => s.kind === "validate" && !s.ok).map((s) => s.detail ?? "");
    expect(steps.some((d) => /unknown properties: deadline/.test(d))).toBe(true);
    expect(steps.some((d) => /unknown function "eval"/.test(d))).toBe(true);
  });

  it("never returns a formula the parser rejects", async () => {
    registerExecutor(fakeExecutor(sequence("price *")));
    const run = await runAgent(formulatorAgent, INPUT);
    expect(run.status).toBe("failed");
    expect(run.output).toBeUndefined();
  });

  it("is registered for the eval and answers in code, any language", () => {
    expect(formulatorAgent.id).toBe("formulator");
    expect(formulatorAgent.language).toBe("any");
  });
});
