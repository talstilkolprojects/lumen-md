/** T30 — the critic learns which suggestion worked on this machine. */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { __resetOutcomes, loadOutcomes, noteRunOutcome, noteSuggestionChosen, rankByOutcomes, successRate } from "../agents/outcomes";
import { review } from "../agents/critic";
import { runSuggestion } from "../agents/suggestions";
import type { AgentRun, Suggestion } from "../agents/types";

const sug = (id: string): Suggestion => ({ id, title: id });
function run(status: AgentRun["status"], label = "validation"): AgentRun {
  return {
    id: "r", agentId: "tagger", executor: "ollama", model: "m", startedAt: 0, endedAt: 0, status, attempts: 3,
    steps: [{ at: 0, kind: "critic", ms: 0, label, ok: false }], suggestions: [], tokens: { input: 0, output: 0, estimated: true }, inputKey: "k",
  } as AgentRun;
}

describe("learning critic", () => {
  beforeEach(async () => {
    __resetOutcomes();
    const b = await loadOutcomes();
    for (const k of Object.keys(b)) delete b[k];
  });

  it("records the outcome of the run that follows a chosen suggestion", async () => {
    noteSuggestionChosen(sug("switch-webllm"), run("failed"));
    await noteRunOutcome(run("ok"));
    const b = await loadOutcomes();
    expect(successRate(b, "validation", "switch-webllm")).toBeGreaterThan(0.6);
    // A run nobody chose a suggestion for records nothing.
    await noteRunOutcome(run("failed"));
    expect(Object.values(b).reduce((n, t) => n + t.ok + t.fail, 0)).toBe(2); // generic + agent-specific
  });

  it("puts what worked here first, and what failed last", async () => {
    for (let i = 0; i < 2; i++) {
      noteSuggestionChosen(sug("larger-model"), run("failed"));
      await noteRunOutcome(run("failed"));
      noteSuggestionChosen(sug("switch-webllm"), run("failed"));
      await noteRunOutcome(run("ok"));
    }
    const ranked = await rankByOutcomes([sug("larger-model"), sug("retry"), sug("switch-webllm")], "validation", "tagger");
    expect(ranked.map((s) => s.id)).toEqual(["switch-webllm", "retry", "larger-model"]);
  });

  it("the critic's verdict comes back in learned order, and persists across a reload", async () => {
    noteSuggestionChosen(sug("retry"), run("failed", "validation"));
    await noteRunOutcome(run("ok"));
    __resetOutcomes(); // a new session: read back from IndexedDB
    const v = await review({ kind: "validation", agentId: "tagger", attempt: 4, maxRetries: 3, tier: "small", executor: "ollama", alternatives: ["webllm"], reason: "bad json" });
    expect(v.suggestions[0].id).toBe("retry");
  });

  it("a suggestion whose action fails leaves no pending choice for a later run", async () => {
    const failed = run("failed");
    // Unsupported executor: the action reports false, no re-run follows.
    expect(await runSuggestion({ id: "pull", title: "pull", action: { type: "pull-model", executor: "openai" as never, model: "m" } }, failed)).toBe(false);
    await noteRunOutcome(run("ok"));
    const b = await loadOutcomes();
    expect(Object.keys(b)).toHaveLength(0);
    // A succeeding action still records the re-run's outcome.
    expect(await runSuggestion({ id: "retry", title: "retry", action: { type: "retry", patch: {} } }, failed)).toBe(true);
    await noteRunOutcome(run("ok"));
    expect(successRate(b, "validation", "retry")).toBeGreaterThan(0.6);
  });
});
