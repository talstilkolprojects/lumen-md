import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => ({ aiKey: null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null }) } }));
vi.mock("../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));
// The eval vault: the agents' tools read it (plan 5.3).
vi.mock("../storage/workspace", async (orig) => (await import("./helpers/evalVault")).workspaceModule(await orig()));
vi.mock("../sync/git", async (orig) => (await import("./helpers/evalVault")).gitModule(await orig()));

import { registerExecutor, resetExecutors } from "../agents/executors";
import { EVAL_CASES } from "../agents/eval/fixtures";
import { runEvalCase } from "../agents/eval/run";
import { formatEvalHtml, formatEvalReport, hebrewRatio, passed, runCheck, scoreCases } from "../agents/eval/score";
import { fakeExecutor, sequence } from "./helpers/fakeExecutor";
import { scriptedAnswer } from "../agents/eval/scripted";

import { installEvalWeb } from "./helpers/evalWeb";

beforeEach(() => {
  resetExecutors();
  installEvalWeb();
});

describe("agent eval — scoring", () => {
  it("hebrewRatio counts letters only and judges structured values, not keys", () => {
    expect(hebrewRatio("שלום world")).toBeCloseTo(4 / 9);
    expect(hebrewRatio("123 !!")).toBe(0);
    expect(runCheck({ type: "hebrew", min: 0.9 }, { tags: ["שלום", "עולם"] }).ok).toBe(true);
  });

  it("each check type passes and fails as documented", () => {
    expect(runCheck({ type: "contains", all: ["A", "b"] }, "a B c").ok).toBe(true);
    expect(runCheck({ type: "contains", all: ["z"] }, "a").detail).toBe("missing: z");
    expect(runCheck({ type: "containsAny", any: ["x", "c"] }, "abc").ok).toBe(true);
    expect(runCheck({ type: "notContains", none: ["b"] }, "abc").ok).toBe(false);
    expect(runCheck({ type: "maxChars", max: 3 }, "abcd").ok).toBe(false);
    expect(runCheck({ type: "maxHebrew", max: 0.02 }, "Dana will send it").ok).toBe(true);
    expect(runCheck({ type: "maxHebrew", max: 0.02 }, "Dana will שלוח it").ok).toBe(false);
    expect(runCheck({ type: "minItems", path: "a.b", min: 2 }, { a: { b: [1, 2] } }).ok).toBe(true);
    expect(runCheck({ type: "matches", source: "^x", flags: "m" }, "a\nx").ok).toBe(true);
  });

  it("someOf: the tagger reuses the vault's tags (7.3.2)", () => {
    expect(runCheck({ type: "someOf", path: "tags", values: ["DevOps"] }, { tags: ["devops", "k8s"] }).ok).toBe(true);
    expect(runCheck({ type: "someOf", path: "tags", values: ["devops"], min: 2 }, { tags: ["devops", "k8s"] }).ok).toBe(false);
    expect(runCheck({ type: "someOf", path: "tags", values: ["devops"] }, { tags: [] }).detail).toBe("none of (empty) is in the list");
  });

  it("mermaid: the diagram is compiled by the real parser (7.3.2)", async () => {
    const [good] = await scoreCases("flowchart TD\n  A[התחלה] --> B[סוף]", [{ type: "mermaid" }]);
    expect(good.ok).toBe(true);
    expect(good.detail).toMatch(/^compiles/);
    const [bad] = await scoreCases("flowchart TD\n  A[open --> B", [{ type: "mermaid" }]);
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/^does not compile/);
  });

  it("the HTML report (7.3.3): one self-contained page, per-agent summary, escaped notes, no scripts", () => {
    const html = formatEvalHtml(
      [
        { id: "a", agent: "tagger", status: "ok", executor: "ollama", model: "m", attempts: 1, ms: 1200, checks: [] },
        { id: "b", agent: "tasker", status: "failed", executor: "ollama", model: "m", attempts: 3, ms: 800, checks: [], error: "<b>bad</b>" },
        { id: "c", agent: "writer", status: "skipped", executor: null, model: null, attempts: 0, ms: 0, checks: [] },
      ],
      { model: "qwen2.5:7b", url: "http://localhost:11434", date: "2026-10-24" },
    );
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<strong>1/2 passed</strong>");
    expect(html).toContain("<td>tagger</td><td>1/1</td>");
    expect(html).toContain("<td>tasker</td><td>0/1</td>");
    expect(html).toContain("&lt;b&gt;bad&lt;/b&gt;");
    expect(html).not.toMatch(/<script|https?:\/\/(?!localhost)/);
  });

  it("the report lists every case with a pass count", () => {
    const md = formatEvalReport(
      [
        { id: "a", agent: "tagger", status: "ok", executor: "ollama", model: "m", attempts: 1, ms: 1200, checks: [] },
        { id: "b", agent: "tasker", status: "failed", executor: "ollama", model: "m", attempts: 3, ms: 800, checks: [], error: "validation: x|y" },
        { id: "c", agent: "writer", status: "skipped", executor: null, model: null, attempts: 0, ms: 0, checks: [] },
      ],
      { model: "qwen2.5:7b", url: "http://localhost:11434", date: "2026-10-17" },
    );
    expect(md).toContain("**1/2 passed**");
    expect(md).toContain("| b | tasker | FAIL | 3 | 0.8 s | validation: x\\|y |");
    expect(md).toContain("| c | writer | skipped |");
  });
});

describe("agent eval — fixtures", () => {
  // 14 in 7.3.1, and the formulator (plan 4.11) since.
  it("every one of the 15 agents has at least five cases, in Hebrew and in English (7.3.1)", () => {
    const by = new Map<string, typeof EVAL_CASES>();
    for (const c of EVAL_CASES) by.set(c.agent, [...(by.get(c.agent) ?? []), c]);
    expect(by.size).toBe(15);
    for (const [agent, cases] of by) {
      expect(cases.length, agent).toBeGreaterThanOrEqual(5);
      expect(cases.some((c) => hebrewRatio(c.input.text ?? "") > 0.5), `${agent}: a Hebrew case`).toBe(true);
      expect(cases.some((c) => hebrewRatio(c.input.text ?? "") < 0.5), `${agent}: an English case`).toBe(true);
    }
  });

  it("the researcher's cases cover the web, citations, the library and a planted injection (7.3.1)", () => {
    const r = EVAL_CASES.filter((c) => c.agent === "researcher");
    expect(r.some((c) => c.run?.grants?.includes("network") && c.tool?.name === "fetch_page")).toBe(true);
    expect(r.every((c) => c.checks.some((k) => k.type === "matches" && k.source.includes("\\[\\^1\\]")))).toBe(true);
    expect(r.some((c) => (c.input.extra as { mode?: string } | undefined)?.mode === "library")).toBe(true);
    expect(r.some((c) => c.checks.some((k) => k.type === "notContains" && k.none.includes("evil.md")))).toBe(true);
  });

  it("every diagram is compiled by Mermaid and the tagger is held to the vault's tags (7.3.2)", () => {
    for (const c of EVAL_CASES.filter((x) => x.agent === "diagrammer")) expect(c.checks.some((k) => k.type === "mermaid"), c.id).toBe(true);
    expect(EVAL_CASES.filter((x) => x.agent === "tagger" && x.checks.some((k) => k.type === "someOf")).length).toBeGreaterThanOrEqual(3);
  });

  it("ids are unique and most cases are Hebrew", () => {
    const ids = EVAL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(EVAL_CASES.filter((c) => hebrewRatio(c.input.text ?? "") > 0.5).length).toBeGreaterThanOrEqual(EVAL_CASES.length / 2);
  });

  for (const c of EVAL_CASES) {
    it(`${c.id}: the expected tool call and the reference answer pass the agent's parser, validators and the checks`, async () => {
      registerExecutor(fakeExecutor((req) => scriptedAnswer(c, req)));
      const r = await runEvalCase(c, { executor: "ollama" });
      expect(r.error).toBeUndefined();
      expect(r.checks.filter((x) => !x.ok)).toEqual([]);
      expect(passed(r)).toBe(true);
      expect(r.attempts).toBe(1);
    });

    it(`${c.id}: --model pins the requested model on every case`, async () => {
      const ex = fakeExecutor(sequence(c.example));
      registerExecutor(ex);
      await runEvalCase(c, { executor: "ollama", model: "llama3.1:8b" });
      expect(ex.calls[0].model).toBe("llama3.1:8b");
    });
  }
});
