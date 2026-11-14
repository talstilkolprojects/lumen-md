/**
 * Plan 5.5: every AI command goes through the agent runtime.
 *
 *   5.5.3  static check: 0 direct `chat()` / `chatStream()` calls (or their
 *          imports) outside the executors; no `executor.chat()` outside the
 *          runtime and its critic; no provider-level calls outside the
 *          executor layer.
 *   5.5.1  the commands that bypassed it run as agents, and each run is in
 *          the trace.
 *   5.5.2  the style profile applies to writer, templater and Rewrite.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => ({ aiKey: null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null }) } }));
vi.mock("../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));

import { registerExecutor, resetExecutors } from "../agents/executors";
import { runAgent } from "../agents/runtime";
import { clearTrace, listRuns, loadTrace } from "../agents/trace";
import {
  answererAgent,
  batchAgent,
  builderArchAgent,
  builderDocsAgent,
  builderTestAgent,
  cleanCompletion,
  completerAgent,
  memoSummarizerAgent,
  rewriterAgent,
  templaterAgent,
  writerAgent,
} from "../agents/defs";
import type { AgentDefinition, AgentInput } from "../agents/types";
import { fakeExecutor, sequence } from "./helpers/fakeExecutor";

const SRC = join(__dirname, "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__") continue;
      out.push(...sources(p));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|eval)\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Comments out of the way, so a doc comment that names chat() is not a call. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("static check (5.5.3)", () => {
  const files = sources(SRC).map((p) => ({ path: relative(SRC, p).replace(/\\/g, "/"), text: code(readFileSync(p, "utf8")) }));

  it("no module outside the executors imports chat() / chatStream() from ai/llm", () => {
    const offenders = files
      .filter((f) => !f.path.startsWith("agents/executors/") && f.path !== "ai/llm.ts")
      .filter((f) => /import\s*\{[^}]*\b(chat|chatStream)\b[^}]*\}\s*from\s*["'][./]*(ai\/)?llm["']/.test(f.text) || /\{[^}]*\b(chat|chatStream)\b[^}]*\}\s*=\s*await import\(["'][./]*(ai\/)?llm["']\)/.test(f.text) || /llm["']\)\)\.(chat|chatStream)\b/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("only the runtime (and its critic) call an executor's chat()", () => {
    const offenders = files.filter((f) => /\bexecutor\.chat\(/.test(f.text) && !["agents/runtime.ts", "agents/modelCritic.ts"].includes(f.path)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("provider-level calls stay in the executor layer", () => {
    const allowed = new Set(["ai/llm.ts", "ai/anthropicProvider.ts", "ai/ollamaProvider.ts", "ai/localLlm.ts"]);
    const offenders = files.filter((f) => !allowed.has(f.path) && !f.path.startsWith("agents/executors/") && /\b(chatAnthropic|chatAnthropicStream|chatOllama|chatOllamaStream|chatLocal|chatLocalStream)\(/.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("the check sees a direct call when there is one", () => {
    const sample = code('import { chat } from "../ai/llm";\nawait chat([]);');
    expect(/import\s*\{[^}]*\bchat\b[^}]*\}\s*from\s*["'][./]*(ai\/)?llm["']/.test(sample)).toBe(true);
    expect(code("// chat() in a comment").includes("chat(")).toBe(false);
  });
});

describe("the commands that bypassed the runtime run as agents (5.5.1)", () => {
  beforeEach(async () => {
    resetExecutors();
    await clearTrace();
    localStorage.clear();
  });

  const cases: Array<[string, AgentDefinition<AgentInput, unknown>, AgentInput, string]> = [
    ["ghost text", completerAgent as never, { text: "The quick brown", extra: { mode: "ghost" } }, "fox jumps"],
    ["inline suggestion", completerAgent as never, { text: "Dear Ma", extra: { mode: "inline" } }, "ria,"],
    ["AI Rewrite", rewriterAgent as never, { text: "hi there", extra: { instruction: "make it formal" } }, "Good day."],
    ["Ask Workspace", answererAgent as never, { text: "When is the launch?", extra: { context: "📄 [1] a.md\nTuesday", history: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] } }, 'Tuesday [1] "Tuesday"'],
    ["voice memo", memoSummarizerAgent as never, { text: "We met and decided to ship on Tuesday." }, "- Met.\n- Ship Tuesday."],
    ["builder: architecture", builderArchAgent as never, { text: "spec", extra: { system: "Design." } }, "# Architecture"],
    ["builder: tests", builderTestAgent as never, { text: "file", extra: { system: "Test." } }, "test('x', () => {});"],
    ["builder: docs", builderDocsAgent as never, { text: "files", extra: { system: "Docs." } }, "# README"],
    ["batch step", batchAgent as never, { text: "note", extra: { system: "Summarise.", maxTokens: 300 } }, "A summary."],
  ];

  for (const [name, def, input, answer] of cases) {
    it(`${name}: runs through the runtime and is in the trace`, async () => {
      const ex = fakeExecutor(sequence(answer));
      registerExecutor(ex);
      const run = await runAgent(def, input, { executor: "ollama" });
      expect(run.status).toBe("ok");
      expect(ex.calls).toHaveLength(1);
      await loadTrace();
      expect(listRuns().some((r) => r.id === run.id && r.agentId === def.id)).toBe(true);
    });
  }

  it("the batch step uses the job's token budget and is not charged again", async () => {
    const ex = fakeExecutor(sequence("ok"));
    registerExecutor(ex);
    const { chargeAiCommandDispatch, consumeAiPrompt } = await import("../billing/aiQuota");
    vi.mocked(chargeAiCommandDispatch).mockClear();
    vi.mocked(consumeAiPrompt).mockClear();
    await runAgent(batchAgent, { text: "n", extra: { system: "s", maxTokens: 321 } }, { executor: "ollama", prepaid: true });
    expect(ex.calls[0].maxTokens).toBe(321);
    expect(chargeAiCommandDispatch).not.toHaveBeenCalled();
    expect(consumeAiPrompt).not.toHaveBeenCalled();
  });

  it("the history of Ask Workspace goes along; the completer keeps one short line", async () => {
    const ex = fakeExecutor(sequence("Tuesday"));
    registerExecutor(ex);
    await runAgent(answererAgent, { text: "And the budget?", extra: { context: "ctx", history: [{ role: "user", content: "When?" }, { role: "assistant", content: "Tuesday" }] } }, { executor: "ollama" });
    expect(ex.calls[0].messages[1].content).toContain("Q: When?\nA: Tuesday");
    expect(cleanCompletion('Completion: "The quick brown fox jumps"\nand more', "The quick brown")).toBe(" fox jumps");
  });
});

describe("the style profile applies to writer, templater and Rewrite (5.5.2)", () => {
  it("each system prompt carries the active profile", () => {
    localStorage.setItem("lumen.ai.styleProfile", JSON.stringify({ tone: "Terse", rules: ["Short sentences"], examples: [], notes: 2, builtAt: "x", sampleV: 2 }));
    localStorage.setItem("lumen.ai.styleProfile.active", "1");
    for (const def of [writerAgent, templaterAgent, rewriterAgent] as Array<AgentDefinition<AgentInput, unknown>>) {
      const sys = typeof def.system === "function" ? def.system({ text: "x", extra: { instruction: "y", templateId: "t" } }) : def.system;
      expect(sys, def.id).toContain("Short sentences");
    }
  });
});
