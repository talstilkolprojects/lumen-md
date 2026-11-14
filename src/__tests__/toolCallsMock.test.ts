/**
 * Plan W4.31 — the 200 tool-call probes through the real runtime against
 * the slip mock (src/agents/eval/toolCalls.ts): a deterministic mix of the
 * slips small models make. It proves the repair and the one retry recover
 * them; the share on a real model comes from `npm run eval:tool-calls`
 * (in `npm run models:day`), never from this file.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => ({ aiKey: null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null }) } }));
vi.mock("../store/useToastStore", () => ({ toast: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));

import { PROBE_TOOLS, TOOL_PROBES } from "../agents/eval/toolProbes";
import { SLIPS, argsMatch, mockReply, passedBefore, runProbe, slipExecutor, slipFor, summarize, type ProbeResult } from "../agents/eval/toolCalls";
import { registerExecutor, resetExecutors } from "../agents/executors";
import { listStagedChanges } from "../agents/staging";

describe("the probe set", () => {
  it("has 200 probes, 100 per language, 20 per tool, each offering five tools with the expected one", () => {
    expect(TOOL_PROBES).toHaveLength(200);
    expect(TOOL_PROBES.filter((p) => p.lang === "he")).toHaveLength(100);
    expect(new Set(TOOL_PROBES.map((p) => p.id)).size).toBe(200);
    for (const t of PROBE_TOOLS) expect(TOOL_PROBES.filter((p) => p.expect.tool === t.name), t.name).toHaveLength(20);
    for (const p of TOOL_PROBES) {
      expect(p.tools, p.id).toHaveLength(5);
      expect(p.tools, p.id).toContain(p.expect.tool);
    }
  });

  it("matches arguments loosely only where it should", () => {
    expect(argsMatch({ query: "budget review" }, { query: "Budget review notes" })).toBe(true);
    expect(argsMatch({ path: "notes/todo.md" }, { path: "notes/todo" })).toBe(false);
    expect(argsMatch({ set: { status: "done" } }, { set: { status: "Done" }, path: "x" })).toBe(true);
    expect(argsMatch({ remove: ["old", "temp"] }, { remove: ["temp", "old"] })).toBe(true);
    expect(argsMatch({ limit: 5 }, { limit: 5 })).toBe(true);
  });

  it("the slip mix sums to 1, and the parser before W4.31 accepts exactly the clean replies", () => {
    expect(SLIPS.reduce((n, [, s]) => n + s, 0)).toBeCloseTo(1, 9);
    const p = TOOL_PROBES[0];
    const res = (content: string) => ({ content, toolCalls: [], model: "m" });
    expect(passedBefore(res(mockReply(p, 2, PROBE_TOOLS)), PROBE_TOOLS)).toBe(true);
    expect(passedBefore(res(JSON.stringify({ name: p.expect.tool, arguments: p.expect.args })), PROBE_TOOLS)).toBe(false);
  });
});

describe("the 200 probes through the runtime, against the slip mock", () => {
  let rows: ProbeResult[] = [];
  beforeAll(async () => {
    resetExecutors();
    registerExecutor(slipExecutor(TOOL_PROBES, PROBE_TOOLS));
    rows = [];
    for (const p of TOOL_PROBES) rows.push(await runProbe(p, PROBE_TOOLS, { executorId: "ollama" }));
  }, 120_000);
  afterAll(() => resetExecutors());

  it("makes ≥ 95 % valid calls in each language, and recovers what the old parser lost", () => {
    const s = summarize(rows);
    expect(s.total).toBe(200);
    expect(s.share).toBeGreaterThanOrEqual(0.95);
    expect(s.byLang.he.valid / s.byLang.he.total).toBeGreaterThanOrEqual(0.95);
    expect(s.byLang.en.valid / s.byLang.en.total).toBeGreaterThanOrEqual(0.95);
    expect(s.before).toBeLessThan(s.valid);
    expect(s.recovered).toBe(s.valid - rows.filter((r) => r.valid && r.before).length);
    // Each slip lands where it should: the wrong tool stays wrong, a missing value is asked for once, never invented.
    for (const r of rows) {
      const slip = slipFor(r.id);
      if (slip === "wrong-tool" && r.called !== r.expected) expect(r.valid, r.id).toBe(false);
      else expect(r.valid, `${r.id} (${slip}): ${r.error ?? ""}`).toBe(true);
      if (slip === "missing-required" || slip === "unknown-tool") expect(r.retried, r.id).toBe(true);
    }
  });

  it("calls with the right arguments, and writes nothing", () => {
    const s = summarize(rows);
    expect(s.argsMatch).toBe(s.valid);
    expect(listStagedChanges()).toEqual([]);
  });
});
