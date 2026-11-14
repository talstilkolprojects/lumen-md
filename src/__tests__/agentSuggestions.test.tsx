import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => ({ aiKey: null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null }) } }));
vi.mock("../store/useToastStore", () => ({ toast: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));
const pulled: string[] = [];
vi.mock("../ai/ollamaProvider", async (orig) => ({
  ...(await orig<object>()),
  pullOllamaModel: async function* (m: string) {
    pulled.push(m);
    yield { status: "pulling", completed: 5, total: 10 };
  },
  getBaseUrl: () => "http://localhost:11434",
}));
vi.mock("../agents/executors/ollama", async (orig) => ({ ...(await orig<object>()), refreshOllama: vi.fn(async () => ({})) }));

import { registerExecutor, resetExecutors } from "../agents/executors";
import { runAgent, runAgentOrThrow, AgentRunError, inputKeyOf } from "../agents/runtime";
import { reportAgentFailure, runSuggestion, setNextRunPatch, onAgentSuggestions } from "../agents/suggestions";
import { setModelCritic, review } from "../agents/critic";
import { modelReview } from "../agents/modelCritic";
import { AiSuggestionsPanel } from "../ui/AiSuggestionsPanel";
import { fakeExecutor, sequence } from "./helpers/fakeExecutor";
import type { AgentDefinition, AgentRun } from "../agents/types";

const textAgent: AgentDefinition = { id: "t", commandId: "ai.test", description: "", system: "s", user: (i) => i.text ?? "" };
const jsonAgent: AgentDefinition<{ text: string }, unknown> = { id: "j", commandId: "ai.json", description: "", system: "s", user: (i) => i.text, outputSchema: { type: "object", required: ["x"] } };

beforeEach(() => {
  resetExecutors();
  setModelCritic(null);
  localStorage.clear();
});

describe("suggestions", () => {
  it("a patch set for an agent applies to its next run only", async () => {
    const ex = fakeExecutor(sequence("ok"));
    registerExecutor(ex);
    setNextRunPatch("t", { tier: "large", temperature: 0 });
    await runAgent(textAgent, { text: "a" });
    expect(ex.calls[0]).toMatchObject({ tier: "large", temperature: 0 });
    await runAgent(textAgent, { text: "a" });
    expect(ex.calls[1].tier).toBe("small");
  });

  it("a retry patch waits for the input that failed (other inputs of the same command run untouched)", async () => {
    const ex = fakeExecutor(sequence("ok"));
    registerExecutor(ex);
    setNextRunPatch("t", { tier: "large" }, inputKeyOf(textAgent, { text: "chunk 2" }));
    await runAgent(textAgent, { text: "chunk 1" });
    expect(ex.calls[0].tier).toBe("small");
    await runAgent(textAgent, { text: "chunk 2" });
    expect(ex.calls[1].tier).toBe("large");
    await runAgent(textAgent, { text: "chunk 2" });
    expect(ex.calls[2].tier).toBe("small");
  });

  it("a forced executor that is still offline is consumed, so later runs pick normally", async () => {
    registerExecutor(fakeExecutor(sequence("ok")));
    registerExecutor({ ...fakeExecutor(sequence("ok")), id: "webllm", available: async () => ({ available: false, reason: "no-webgpu" }) });
    setNextRunPatch("t", { executor: "webllm" });
    const first = await runAgent(textAgent, { text: "a" });
    expect(first.errorCode).toBe("no-executor");
    const second = await runAgent(textAgent, { text: "a" });
    expect(second.status).toBe("ok");
    expect(second.executor).toBe("ollama");
  });

  it("actions: retry/switch set the next-run patch, set-policy changes the policy, pull-model pulls", async () => {
    const run = { agentId: "t" } as AgentRun;
    expect(await runSuggestion({ id: "r", title: "x", action: { type: "retry", patch: { tier: "medium" } } }, run)).toBe(true);
    expect(await runSuggestion({ id: "p", title: "x", action: { type: "set-policy", policy: "local-first" } }, run)).toBe(true);
    expect(localStorage.getItem("lumen.ai.policy")).toBe("local-first");
    const progress: string[] = [];
    expect(await runSuggestion({ id: "m", title: "x", action: { type: "pull-model", executor: "ollama", model: "qwen2.5:7b" } }, run, { onProgress: (t) => progress.push(t) })).toBe(true);
    expect(pulled).toEqual(["qwen2.5:7b"]);
    expect(progress).toEqual(["pulling 50%"]);
    expect(await runSuggestion({ id: "s", title: "x", action: { type: "split-input" } }, run)).toBe(false);
  });

  it("reportAgentFailure opens the panel for agent failures only", async () => {
    registerExecutor(fakeExecutor(sequence("not json")));
    const seen: AgentRun[] = [];
    const off = onAgentSuggestions((e) => seen.push(e.run));
    try {
      const err = await runAgentOrThrow(jsonAgent, { text: "x" }).catch((e) => e);
      expect(err).toBeInstanceOf(AgentRunError);
      expect(reportAgentFailure(err)).toBe(true);
      expect(seen[0].suggestions.length).toBeGreaterThan(0);
      expect(reportAgentFailure(new Error("plain"))).toBe(false);
    } finally {
      off();
    }
  });

  it("the model critic adds plain-language suggestions only after retries are exhausted", async () => {
    const ex = fakeExecutor(sequence('{"diagnosis":"too long","suggestions":[{"title":"Select one section","detail":"Smaller input."}]}'));
    registerExecutor(ex);
    const base = { kind: "validation" as const, maxRetries: 2, tier: "small" as const, executor: "ollama" as const, reason: "bad", agentId: "j" };
    const v = await modelReview({ ...base, attempt: 3 }, { diagnosis: "validation", suggestions: [] });
    expect(v?.suggestions).toEqual([{ id: "model-0", title: "Select one section", detail: "Smaller input.", raw: true }]);
    expect(ex.calls[0].tier).toBe("tiny");
    setModelCritic(async () => ({ diagnosis: "m", suggestions: [{ id: "model-0", title: "X", raw: true }] }));
    expect((await review({ ...base, attempt: 1 })).suggestions.map((s) => s.id)).toEqual([]); // retry available: no model call
    expect((await review({ ...base, attempt: 3 })).suggestions.map((s) => s.id)).toEqual(["model-0"]);
    expect(await modelReview({ ...base, attempt: 3, agentId: "critic" }, { diagnosis: "x", suggestions: [] })).toBeNull();
  });
});

describe("cancelling during the model critic", () => {
  it("Esc during the critic's request aborts that request and the run reports aborted", async () => {
    const ctrl = new AbortController();
    let criticSignal: AbortSignal | undefined;
    // The agent's answers are unusable JSON; the tiny-tier call is the critic.
    registerExecutor(
      fakeExecutor((req) => {
        if (req.tier !== "tiny") return { content: "not json", toolCalls: [], model: "m", usage: { inputTokens: 1, outputTokens: 1, estimated: true } };
        criticSignal = req.signal;
        return new Promise((_, reject) => {
          req.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          ctrl.abort(); // the user presses Esc while the critic is thinking
        });
      }),
    );
    setModelCritic((f, v) => modelReview(f, v).catch(() => null));
    const run = await runAgent(jsonAgent, { text: "x" }, { signal: ctrl.signal });
    expect(criticSignal).toBe(ctrl.signal);
    expect(criticSignal?.aborted).toBe(true);
    expect(run.status).toBe("aborted");
  });
});

describe("AiSuggestionsPanel", () => {
  it("shows the failure and runs an action, then asks the app to re-run the command", async () => {
    const reruns: string[] = [];
    window.addEventListener("lumen-run-command", (e) => reruns.push((e as CustomEvent).detail.id));
    render(<AiSuggestionsPanel />);
    const run = { agentId: "tagger", commandId: "tools.autoTag", attempts: 3, executor: "ollama", model: "qwen2.5:7b", error: "no usable tags", status: "failed", suggestions: [{ id: "allow-cloud", title: "agent.suggest.allowCloud", action: { type: "set-policy", policy: "local-first" } }, { id: "model-0", title: "Select one section", raw: true }] } as unknown as AgentRun;
    act(() => {
      reportAgentFailure(new AgentRunError(run, "x"));
    });
    expect(screen.getByText("Allow the cloud as a fallback")).toBeTruthy();
    expect(screen.getByText("Select one section")).toBeTruthy();
    expect(screen.getByText(/tagger · 3 attempt/)).toBeTruthy();
    fireEvent.click(screen.getByText("Do it"));
    await waitFor(() => expect(reruns).toEqual(["tools.autoTag"]));
    expect(localStorage.getItem("lumen.ai.policy")).toBe("local-first");
  });
});
