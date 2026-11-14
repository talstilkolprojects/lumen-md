/** T55 — one AI system, and every AI call can be cancelled. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { __resetAiAbort, aiBusy, aiOperation, cancelAllAi, installAiEscape, isAbort, withAiOperation } from "../ai/aiAbort";

describe("AI cancellation", () => {
  beforeEach(() => __resetAiAbort());

  it("cancelAllAi aborts every running operation", () => {
    const a = aiOperation();
    const b = aiOperation();
    expect(aiBusy()).toBe(true);
    expect(cancelAllAi()).toBe(2);
    expect(a.signal.aborted && b.signal.aborted).toBe(true);
    expect(aiBusy()).toBe(false);
  });

  it("Esc cancels, and an aborted run resolves quietly", async () => {
    const cancelled = vi.fn();
    installAiEscape(cancelled);
    const p = withAiOperation((signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect(p).resolves.toBeUndefined();
    expect(cancelled).toHaveBeenCalledWith(1);
  });

  it("Esc cancels even when a nested handler stops its propagation", () => {
    const cancelled = vi.fn();
    installAiEscape(cancelled);
    const stop = (e: Event) => e.stopPropagation();
    document.addEventListener("keydown", stop); // e.g. an open toolbar menu
    try {
      const op = aiOperation();
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(op.signal.aborted).toBe(true);
    } finally {
      document.removeEventListener("keydown", stop);
    }
  });

  it("recognises aborts from fetch and from the agent runtime", () => {
    expect(isAbort(new DOMException("x", "AbortError"))).toBe(true);
    expect(isAbort({ name: "AgentRunError", run: { status: "aborted" } })).toBe(true);
    expect(isAbort(new Error("boom"))).toBe(false);
  });

  it("the agent helpers pass the signal to the runtime", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    vi.doMock("../agents/runtime", () => ({ runAgentOrThrow: async (_d: unknown, _i: unknown, o: { signal?: AbortSignal }) => (seen.push(o.signal), "graph TD; a-->b") }));
    vi.resetModules();
    const { generateDiagram } = await import("../agents/commands");
    const op = aiOperation();
    await generateDiagram("text", op.signal);
    expect(seen[0]).toBe(op.signal);
    vi.doUnmock("../agents/runtime");
  });

  it("the old prompt-only framework is gone", () => {
    expect(existsSync(join(__dirname, "../ai/agents.ts"))).toBe(false);
  });
});
