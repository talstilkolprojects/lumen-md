/**
 * Plan 5.6 — the complete improvement agent:
 *   5.6.1 the model critic's diagnosis comes with a retry the runtime runs;
 *   5.6.2 "split the document" really runs the agent on parts and merges;
 *   5.6.3 "not good" re-runs the command with a recorded link to the run it re-does;
 *   5.6.4 every agent failure reaches the suggestions panel;
 *   5.6.5 "start Ollama" checks live until the server answers.
 * Acceptance: every suggestion performs an action — one test per action type.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => ({ aiKey: null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null }) } }));
vi.mock("../store/useToastStore", () => ({ toast: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));
const ollama = vi.hoisted(() => ({ upAfter: 0, probes: 0, pulled: [] as string[], loaded: [] as string[] }));
vi.mock("../ai/ollamaProvider", async (orig) => ({
  ...(await orig<object>()),
  isOllamaAvailable: async () => ++ollama.probes > ollama.upAfter,
  getBaseUrl: () => "http://localhost:11434",
  pullOllamaModel: async function* (m: string) {
    ollama.pulled.push(m);
    yield { status: "pulling", completed: 1, total: 1 };
  },
}));
vi.mock("../ai/webllmEngine", async (orig) => ({ ...(await orig<object>()), loadWebLlmModel: async (m: string) => void ollama.loaded.push(m), onWebLlmProgress: () => () => {} }));
vi.mock("../agents/executors/ollama", async (orig) => ({ ...(await orig<object>()), refreshOllama: vi.fn(async () => ({ models: [] })) }));

import { registerExecutor, resetExecutors } from "../agents/executors";
import { mergeOutputs, runAgent, runAgentOrThrow, splitText, AgentRunError } from "../agents/runtime";
import { __retriedRuns, markNotGood, onAgentAnswer, reportAgentFailure, runSuggestion, setNextRunPatch, waitForOllama } from "../agents/suggestions";
import { diagnose, review, setModelCritic, SPLIT_SIZE } from "../agents/critic";
import { modelReview } from "../agents/modelCritic";
import { listRuns } from "../agents/trace";
import { registerAgent } from "../agents/registry";
import { AiSuggestionsPanel } from "../ui/AiSuggestionsPanel";
import { fakeExecutor, reply, sequence } from "./helpers/fakeExecutor";
import type { AgentDefinition, AgentRun, Suggestion, SuggestionAction } from "../agents/types";

const jsonAgent: AgentDefinition<{ text: string }, unknown> = { id: "j", commandId: "ai.json", description: "", system: "s", user: (i) => i.text, outputSchema: { type: "object", required: ["x"] } };
const tagsAgent = registerAgent<{ text: string }, { tags: string[] }>({ id: "tags-test", commandId: "tools.autoTag", description: "", system: "tag", user: (i) => i.text, outputSchema: { type: "object", required: ["tags"] }, splittable: true, maxRetries: 0 });

beforeEach(() => {
  resetExecutors();
  setModelCritic(null);
  localStorage.clear();
  Object.assign(ollama, { upAfter: 0, probes: 0, pulled: [], loaded: [] });
});

describe("5.6.1 the model critic's retry is executed", () => {
  it("after the retries are spent, the model's diagnosis brings one more attempt with its instruction, and it succeeds", async () => {
    const ex = fakeExecutor((req, n) => {
      if (req.tier === "tiny") return reply('{"diagnosis":"wrong key","suggestions":[],"retry":{"instruction":"Answer with the key x.","temperature":0}}');
      // The agent's attempts: three bad ones, then (with the critic's instruction) a good one.
      return reply(req.messages.at(-1)!.content.includes("Answer with the key x.") ? '{"x":1}' : '{"y":1}');
      void n;
    });
    registerExecutor(ex);
    setModelCritic((f, v) => modelReview(f, v));
    const run = await runAgent(jsonAgent, { text: "go" });
    expect(run.status).toBe("ok");
    expect(run.output).toEqual({ x: 1 });
    expect(run.attempts).toBe(4); // maxRetries 2 + 1, then the model critic's attempt
    expect(run.steps.some((s) => s.kind === "retry" && s.label.includes("model critic"))).toBe(true);
  });

  it("no retry from the model for a failure a new attempt cannot fix (no executor, network)", async () => {
    registerExecutor(fakeExecutor(sequence('{"suggestions":[],"retry":{"instruction":"x"}}')));
    const v = await modelReview({ kind: "error", attempt: 3, maxRetries: 2, tier: "small", executor: "ollama", reason: "ECONNREFUSED", agentId: "j" }, { diagnosis: "error", suggestions: [] });
    expect(v?.retry).toBeUndefined();
  });
});

describe("5.6.2 split the document", () => {
  it("splitText keeps parts under the size, cuts at blank lines and never inside a code fence", () => {
    const text = ["# A", "", "x ".repeat(30), "", "```js", "const a = 1;", "", "const b = 2;", "```", "", "y ".repeat(30)].join("\n");
    const parts = splitText(text, 70);
    expect(parts.every((p) => p.length <= 70)).toBe(true);
    expect(parts.join("\n").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
    expect(parts.some((p) => p.includes("const a = 1;") && p.includes("const b = 2;"))).toBe(true);
    // One sentence longer than a part: hard cuts, each within the size.
    const run = splitText("a".repeat(250), 70);
    expect(run.every((p) => p.length <= 70)).toBe(true);
    expect(run.join("")).toBe("a".repeat(250));
  });

  it("mergeOutputs joins text and concatenates JSON lists without repeats", () => {
    expect(mergeOutputs(["a", "b"])).toBe("a\n\nb");
    expect(mergeOutputs([{ tags: ["a", "b"], tone: "x" }, { tags: ["b", "c"], tone: "y" }])).toEqual({ tags: ["a", "b", "c"], tone: "x" });
    expect(mergeOutputs([{ issues: [{ q: 1 }] }, { issues: [{ q: 1 }] }])).toEqual({ issues: [{ q: 1 }, { q: 1 }] });
  });

  it("the suggestion runs the agent on each part and merges; a non-splittable agent gets 'select a part' instead", async () => {
    const long = Array.from({ length: 6 }, (_, i) => `פסקה ${i} `.repeat(150)).join("\n\n");
    const v = diagnose({ kind: "validation", attempt: 3, maxRetries: 2, tier: "small", executor: "ollama", inputChars: long.length, splittable: true });
    const split = v.suggestions.find((s) => s.id === "split-input")!;
    expect(split.action).toEqual({ type: "retry", patch: { split: SPLIT_SIZE } });
    expect(diagnose({ kind: "validation", attempt: 3, maxRetries: 2, tier: "small", executor: "ollama", inputChars: long.length }).suggestions.find((s) => s.id === "select-part")?.action).toEqual({ type: "split-input" });

    const ex = fakeExecutor((req) => reply(JSON.stringify({ tags: [`t${req.messages.at(-1)!.content.match(/פסקה (\d)/)?.[1]}`] })));
    registerExecutor(ex);
    await runSuggestion(split, { agentId: tagsAgent.id, inputKey: undefined } as AgentRun);
    const run = await runAgent(tagsAgent, { text: long });
    expect(run.status).toBe("ok");
    expect(ex.calls.length).toBeGreaterThan(1);
    expect(ex.calls.every((c) => c.messages.at(-1)!.content.length < SPLIT_SIZE + 500)).toBe(true);
    expect((run.output as { tags: string[] }).tags.length).toBe(ex.calls.length);
    expect(run.steps.filter((s) => s.label.startsWith("part ")).length).toBe(ex.calls.length);
  });
});

describe("5.6.3 'not good'", () => {
  it("re-runs the command with a different-answer patch and records which run it re-does", async () => {
    const reruns: string[] = [];
    const onRun = (e: Event) => reruns.push((e as CustomEvent).detail.id);
    window.addEventListener("lumen-run-command", onRun);
    const ex = fakeExecutor(sequence('{"tags":["first"]}', '{"tags":["second"]}'));
    registerExecutor(ex);
    const answers: AgentRun[] = [];
    const off = onAgentAnswer((e) => answers.push(e.run));
    try {
      const first = await runAgent(tagsAgent, { text: "note" });
      expect(answers.at(-1)!.id).toBe(first.id);
      await markNotGood(first);
      expect(reruns).toEqual(["tools.autoTag"]);
      const again = await runAgent(tagsAgent, { text: "note" });
      expect(again.retryOf).toBe(first.id);
      expect(ex.calls[1].temperature).toBe(0.7);
      expect(ex.calls[1].messages.at(-1)!.content).toContain("rejected this previous answer");
      expect(ex.calls[1].messages.at(-1)!.content).toContain("first");
      expect(__retriedRuns().get(first.id)).toBe(again.id);
      // The trace keeps the link.
      expect(listRuns().find((r) => r.id === again.id)?.retryOf).toBe(first.id);
    } finally {
      off();
      window.removeEventListener("lumen-run-command", onRun);
    }
  });

  it("the chip appears after a judged command's answer, and its button marks it", async () => {
    registerExecutor(fakeExecutor(sequence('{"tags":["a"]}')));
    render(<AiSuggestionsPanel />);
    await act(async () => {
      await runAgent(tagsAgent, { text: "chip" });
    });
    const chip = await screen.findByTestId("ai-not-good");
    const reruns: string[] = [];
    const onRun = (e: Event) => reruns.push((e as CustomEvent).detail.id);
    window.addEventListener("lumen-run-command", onRun);
    fireEvent.click(chip.querySelector("button")!);
    await waitFor(() => expect(reruns).toEqual(["tools.autoTag"]));
    window.removeEventListener("lumen-run-command", onRun);
  });
});

describe("5.6.4 every failure reaches the panel", () => {
  it("AgentRunError with suggestions → panel; the commands that used to toast now report", async () => {
    registerExecutor(fakeExecutor(sequence("not json")));
    const err = await runAgentOrThrow(jsonAgent, { text: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentRunError);
    render(<AiSuggestionsPanel />);
    act(() => {
      expect(reportAgentFailure(err, "ai.json")).toBe(true);
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("the remaining callers hand failures to reportAgentFailure", async () => {
    const { readFileSync } = await import("node:fs");
    for (const [file, id] of [
      // useCommands.ts is split into per-domain builders (#208).
      ["src/commands/domains/research.ts", "research.ask"],
      // The batch bodies load on use (044e87aa, train 3): batchActions.ts.
      ["src/commands/domains/batchActions.ts", "ai.batch"],
      ["src/ui/SearchDialog.tsx", "search.askWorkspace"],
      ["src/plugins/CsvBlock.tsx", "ai.chart"],
      // The selection tooltip is its own module (W6.25, train 5).
      ["src/editor/wysiwygTooltip.ts", "wysiwyg.aiRewrite"],
      ["src/editor/WysiwygEditor.tsx", "wysiwyg.aiWrite"],
    ])
      expect(readFileSync(file, "utf8"), `${file} ${id}`).toMatch(new RegExp(`reportAgentFailure\\(e, "${id.replace(".", "\\.")}"\\)`));
  });
});

describe("5.6.5 start Ollama with a live check", () => {
  it("polls until Ollama answers, then re-runs; gives up when it never does; the close button stops it", async () => {
    ollama.upAfter = 2;
    const progress: string[] = [];
    expect(await waitForOllama({ pollMs: 1, waitMs: 1000, onProgress: (t) => progress.push(t) })).toBe(true);
    expect(ollama.probes).toBe(3);
    expect(progress.at(-1)).toMatch(/answers at http:\/\/localhost:11434/);
    Object.assign(ollama, { upAfter: 1e9, probes: 0 });
    expect(await waitForOllama({ pollMs: 1, waitMs: 20 })).toBe(false);
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await waitForOllama({ pollMs: 1, waitMs: 1000, signal: ctrl.signal })).toBe(false);
  });

  it("the critic offers it as a live check (not a docs link) when Ollama is offline", () => {
    const v = diagnose({ kind: "no-executor", attempt: 1, maxRetries: 2, tier: "small", executor: null, skipped: [{ id: "ollama", availability: { available: false, reason: "ollama-offline" } }] });
    expect(v.suggestions[0]).toMatchObject({ id: "start-ollama", action: { type: "check-ollama" } });
  });
});

describe("acceptance: every suggestion the critic produces performs an action", () => {
  const actions: Record<SuggestionAction["type"], (s: Suggestion) => Promise<void>> = {
    retry: async (s) => {
      expect(await runSuggestion(s, { agentId: "a1" } as AgentRun)).toBe(true);
      // The patch waits for the next run of that agent.
      const ex = fakeExecutor(sequence('{"x":1}'));
      registerExecutor(ex);
      await runAgent({ ...jsonAgent, id: "a1" }, { text: "z".repeat(10) });
      const patch = (s.action as { patch: { temperature?: number } }).patch;
      if (patch.temperature !== undefined) expect(ex.calls[0].temperature).toBe(patch.temperature);
    },
    "switch-executor": async (s) => {
      expect(await runSuggestion(s, { agentId: "a2" } as AgentRun)).toBe(true);
      setNextRunPatch("a2", {}); // consumed
    },
    "set-policy": async (s) => {
      expect(await runSuggestion(s, { agentId: "a3" } as AgentRun)).toBe(true);
      expect(localStorage.getItem("lumen.ai.policy")).toBe((s.action as { policy: string }).policy);
    },
    "pull-model": async (s) => {
      expect(await runSuggestion(s, { agentId: "a4" } as AgentRun)).toBe(true);
      expect([...ollama.pulled, ...ollama.loaded]).toContain((s.action as { model: string }).model);
    },
    "open-docs": async (s) => {
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      expect(await runSuggestion(s, { agentId: "a5" } as AgentRun)).toBe(false);
      expect(open).toHaveBeenCalledTimes(1);
      open.mockRestore();
    },
    "split-input": async (s) => {
      const progress: string[] = [];
      expect(await runSuggestion(s, { agentId: "a6" } as AgentRun, { onProgress: (t) => progress.push(t) })).toBe(false);
      expect(progress[0]).toMatch(/Select the part/);
    },
    "check-ollama": async (s) => {
      ollama.upAfter = 0;
      expect(await runSuggestion(s, { agentId: "a7" } as AgentRun, { pollMs: 1, waitMs: 100 })).toBe(true);
    },
    "run-command": async (s) => {
      const reruns: string[] = [];
      const onRun = (e: Event) => reruns.push((e as CustomEvent).detail.id);
      window.addEventListener("lumen-run-command", onRun);
      await runSuggestion(s, { agentId: "a8" } as AgentRun);
      window.removeEventListener("lumen-run-command", onRun);
      expect(reruns).toEqual([(s.action as { id: string }).id]);
    },
  };

  it("collects the suggestions of every diagnosis and runs each one's action", async () => {
    const long = 9000;
    const reasons = ["ollama-offline", "cors", "no-webgpu", "no-local", "no-model", "policy", "no-key"] as const;
    const verdicts = [
      ...reasons.map((r) => diagnose({ kind: "no-executor", attempt: 1, maxRetries: 2, tier: "small", executor: null, skipped: [{ id: r === "no-model" ? "ollama" : "webllm", availability: { available: false, reason: r, detail: r === "no-model" ? "qwen2.5:7b" : "openai" } }] })),
      ...["403 forbidden", "model \"qwen3\" not found", "maximum context exceeded", "ECONNREFUSED", "weird"].map((reason) => diagnose({ kind: "error", attempt: 3, maxRetries: 2, tier: "small", executor: "ollama", reason, alternatives: ["webllm"], inputChars: long, splittable: true })),
      ...(["validation", "parse", "empty", "tool"] as const).map((kind) => diagnose({ kind, attempt: 3, maxRetries: 2, tier: "small", executor: "ollama", reason: "bad", inputChars: long, splittable: true, alternatives: ["webllm"] })),
      diagnose({ kind: "validation", attempt: 3, maxRetries: 2, tier: "small", executor: "ollama", inputChars: long }),
    ];
    const all = verdicts.flatMap((v) => v.suggestions);
    // Every suggestion has an action, and every action type the critic emits is exercised.
    expect(all.filter((s) => !s.action).map((s) => s.id)).toEqual([]);
    const seen = new Set<string>();
    for (const s of all) {
      const type = s.action!.type;
      expect(actions[type], type).toBeTruthy();
      await actions[type](s);
      seen.add(type);
    }
    expect([...seen].sort()).toEqual(Object.keys(actions).sort());
    // The model critic's plain-language suggestions carry no action: they are advice, shown as text.
    expect((await review({ kind: "validation", attempt: 3, maxRetries: 2, tier: "small", executor: "ollama" })).suggestions.every((s) => s.action)).toBe(true);
  });
});
