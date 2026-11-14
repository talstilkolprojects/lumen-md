/**
 * Plan W7.15 — speculative decoding in Ollama 0.34: pinned off for
 * reproducible runs, measured per model, kept only where it is ≥ 10 %
 * faster. The real measurement on Tal's Mac is `node scripts/ollama-speculative.mjs`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../ai/ollamaProvider", () => ({ getBaseUrl: () => "http://127.0.0.1:11434" }));

import { decide, draftOptions, measurementFor, MIN_SPEEDUP, readMeasurements, REPRODUCIBLE_KEY, saveMeasurement, versionAtLeast, type SpeculativeMeasurement } from "../ai/speculative";
import { describeMeasurement, measureSpeculative, scheduleMeasurement, tokensPerSecond } from "../ai/speculativeMeasure";
import { ollamaExecutor, refreshOllama, __resetOllamaState } from "../agents/executors/ollama";

const m = (over: Partial<SpeculativeMeasurement> = {}): SpeculativeMeasurement => ({ model: "qwen3.6:27b", ollama: "0.34.4", withDraft: 115, withoutDraft: 48, speedup: 2.4, decision: "default", at: "x", ...over });

/** Ollama's generate: `rate(pinned)` tokens per second. */
const fakeGenerate = (rate: (pinned: boolean) => number, seen: unknown[] = []) =>
  vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as { options: Record<string, number> };
    seen.push(body.options);
    const tps = rate(body.options.draft_num_predict === 0);
    return new Response(JSON.stringify({ response: "x", eval_count: 128, eval_duration: (128 / tps) * 1e9 }), { status: 200 });
  }) as unknown as typeof fetch;

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("what each request carries", () => {
  it("nothing before Ollama 0.34 (the option is unknown there) and by default", () => {
    expect(draftOptions("qwen3.6:27b", "0.33.2")).toEqual({});
    expect(draftOptions("qwen3.6:27b", "0.34.4")).toEqual({});
    expect(versionAtLeast("0.34.0", "0.34.0")).toBe(true);
    expect(versionAtLeast("0.34.0-rc1", "0.34.0")).toBe(true);
    expect(versionAtLeast("0.4.10", "0.34.0")).toBe(false);
    expect(versionAtLeast("1.0.0", "0.34.0")).toBe(true);
  });

  it("draft_num_predict 0 in reproducible mode (eval, models:day), for every model", () => {
    localStorage.setItem(REPRODUCIBLE_KEY, "1");
    expect(draftOptions("qwen3.6:27b", "0.34.4")).toEqual({ draft_num_predict: 0 });
    expect(draftOptions("gemma4:26b", null)).toEqual({ draft_num_predict: 0 });
  });

  it("draft_num_predict 0 for a model where it did not pay, on that Ollama version only", () => {
    saveMeasurement(m({ model: "qwen3.8:27b", withDraft: 17.4, withoutDraft: 75.1, speedup: 0.23, decision: "off" }));
    expect(draftOptions("qwen3.8:27b", "0.34.4")).toEqual({ draft_num_predict: 0 });
    expect(draftOptions("qwen3.8:27b", "0.35.0")).toEqual({}); // a new version is measured again
    expect(measurementFor("qwen3.8:27b", "0.35.0")).toBeNull();
  });

  it("the Ollama executor sends it in options", async () => {
    __resetOllamaState();
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path === "/api/version") return new Response(JSON.stringify({ version: "0.34.4" }));
        if (path === "/api/tags") return new Response(JSON.stringify({ models: [{ name: "qwen3.8:27b", details: { parameter_size: "27B", family: "qwen3" } }] }));
        if (path === "/api/chat") {
          bodies.push(JSON.parse(String(init!.body)));
          return new Response(JSON.stringify({ model: "qwen3.8:27b", message: { role: "assistant", content: "ok" }, done: true }));
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );
    localStorage.setItem(REPRODUCIBLE_KEY, "1");
    await refreshOllama();
    await ollamaExecutor.chat({ messages: [{ role: "user", content: "hi" }], model: "qwen3.8:27b", temperature: 0 });
    expect((bodies[0]!.options as Record<string, unknown>).draft_num_predict).toBe(0);
    localStorage.removeItem(REPRODUCIBLE_KEY);
    await ollamaExecutor.chat({ messages: [{ role: "user", content: "hi" }], model: "qwen3.8:27b", temperature: 0 });
    expect("draft_num_predict" in (bodies[1]!.options as Record<string, unknown>)).toBe(false);
  });
});

describe("measuring a model", () => {
  it("tokens per second from eval_count and eval_duration (ns)", () => {
    expect(tokensPerSecond({ eval_count: 100, eval_duration: 2e9 })).toBe(50);
    expect(tokensPerSecond({})).toBe(0);
  });

  it("keeps the default only when it is ≥ 10 % faster", () => {
    expect(decide(115, 48)).toBe("default");
    expect(decide(110, 100)).toBe("default");
    expect(decide(109, 100)).toBe("off");
    expect(decide(17.4, 75.1)).toBe("off");
    expect(decide(10, 0)).toBe("off");
    expect(MIN_SPEEDUP).toBe(1.1);
  });

  it("measures with and without, alternating after a warm-up, and stores the decision", async () => {
    const seen: Array<Record<string, number>> = [];
    const r = await measureSpeculative("qwen3.6:27b", "0.34.4", { base: "http://x", runs: 3, fetch: fakeGenerate((pinned) => (pinned ? 48 : 115), seen) });
    expect(seen).toHaveLength(7);
    expect(seen.filter((o) => o.draft_num_predict === 0)).toHaveLength(3);
    expect(seen.every((o) => o.temperature === 0)).toBe(true);
    expect(r).toMatchObject({ decision: "default" });
    expect(r.withDraft).toBeCloseTo(115);
    expect(r.withoutDraft).toBeCloseTo(48);
    expect(readMeasurements()["qwen3.6:27b"]!.decision).toBe("default");
    expect(describeMeasurement(r)).toBe("qwen3.6:27b: 48 → 115 tok/s (×2.4, on)");
  });

  it("0 models where the automatic choice is slower than off", async () => {
    const cases: Array<[string, number, number]> = [
      ["qwen3.6:27b", 115, 48],
      ["gemma4:26b", 294, 157],
      ["qwen3.8:27b", 17.4, 75.1],
      ["llama3.2:3b", 80, 80],
      ["small-gain", 104, 100],
    ];
    for (const [model, on, off] of cases) {
      const r = await measureSpeculative(model, "0.34.4", { base: "http://x", runs: 1, fetch: fakeGenerate((p) => (p ? off : on)) });
      const auto = r.decision === "default" ? r.withDraft : r.withoutDraft;
      expect(auto, model).toBeGreaterThanOrEqual(r.withoutDraft - 1e-9);
    }
    const all = readMeasurements();
    expect(Object.values(all).filter((x) => x.decision === "off").map((x) => x.model).sort()).toEqual(["llama3.2:3b", "qwen3.8:27b", "small-gain"]);
  });

  it("is scheduled once per model and version, never in reproducible mode or before 0.34", () => {
    vi.useFakeTimers?.();
    expect(scheduleMeasurement("a", "0.33.0", "http://x", 1e9)).toBe(false);
    localStorage.setItem(REPRODUCIBLE_KEY, "1");
    expect(scheduleMeasurement("a", "0.34.4", "http://x", 1e9)).toBe(false);
    localStorage.removeItem(REPRODUCIBLE_KEY);
    saveMeasurement(m({ model: "a" }));
    expect(scheduleMeasurement("a", "0.34.4", "http://x", 1e9)).toBe(false);
    vi.useRealTimers?.();
  });
});
