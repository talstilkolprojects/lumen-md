/**
 * Plan W7.14 — one structured-output path for Ollama, web-llm and Chrome's
 * built-in model, and the built-in model as a "zero download" tier.
 *
 * Offline, each engine is a stand-in that speaks its real constraint
 * (Ollama/web-llm get the schema as the executor's `schema`, Chrome gets
 * `responseConstraint`) and answers like a small model does — sometimes in
 * a code fence, sometimes wrong the first time. The same 5 schemas × 50
 * inputs then run on all three. The live run on real engines is the
 * owner's (see conformance.ts).
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { Executor, ExecutorRequest, JsonSchema } from "../agents/types";
import { builtinEngine, checkStructured, engineOrder, executorEngine, generateStructured, StructuredOutputError, type StructuredEngine } from "../ai/structured";
import { builtinAvailability, isMobileBrowser, languageModelApi, type LanguageModelApi } from "../ai/structured/chromeBuiltin";
import { builtinGateOpen, GATE_KEY, saveGate } from "../ai/structured/gate";
import { conformanceInputs, runConformance, runGateEval, SCHEMAS } from "../ai/structured/conformance";

/** A valid answer for a schema (what a constrained decoder produces). */
function answer(schema: JsonSchema, input: string): unknown {
  const s = schema as { type?: unknown; properties?: Record<string, JsonSchema>; enum?: unknown[]; items?: JsonSchema; minItems?: number; pattern?: string; minimum?: number };
  if (s.enum) return s.enum[input.length % s.enum.length];
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (type) {
    case "object":
      return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, answer(v, input)]));
    case "array":
      return Array.from({ length: Math.max(1, s.minItems ?? 1) }, () => answer(s.items ?? { type: "string" }, input));
    case "integer":
    case "number":
      return s.minimum ?? 1;
    case "boolean":
      return input.length % 2 === 0;
    default:
      return s.pattern ? "2026-03-03" : input.split(" ")[0];
  }
}

/** Small-model habits: a fence on every 7th answer, a wrong first try on every 13th. */
let calls = 0;
const style = (json: string) => {
  calls++;
  if (calls % 13 === 0) return "Sure! Here it is: {not json";
  return calls % 7 === 0 ? "```json\n" + json + "\n```" : json;
};

function fakeExecutor(id: "ollama" | "webllm", seen: ExecutorRequest[]): Executor {
  return {
    id,
    label: id,
    available: async () => ({ available: true }),
    supportsTools: () => false,
    supportsSchema: () => true,
    modelFor: () => `${id}-model`,
    async chat(req) {
      seen.push(req);
      const input = String(req.messages[req.messages.length - 1]!.content).split("\n\n")[0]!;
      return { content: style(JSON.stringify(answer(req.schema!, input))), toolCalls: [], model: `${id}-model` };
    },
  };
}

function fakeChrome(seen: unknown[], availability: string = "available"): LanguageModelApi {
  return {
    availability: async () => availability as never,
    create: async () => ({
      prompt: async (input: string, o?: { responseConstraint?: unknown }) => {
        seen.push(o?.responseConstraint);
        return style(JSON.stringify(answer(o!.responseConstraint as JsonSchema, input.split("\n\n")[0]!)));
      },
      destroy() {},
    }),
  };
}

beforeEach(() => {
  calls = 0;
  localStorage.clear();
});

describe("the same schema on three engines (5 schemas × 50 inputs)", () => {
  it("each engine gets the schema as its own constraint and ≥ 98 % of the answers are valid", async () => {
    const ollamaSeen: ExecutorRequest[] = [];
    const webSeen: ExecutorRequest[] = [];
    const chromeSeen: unknown[] = [];
    const engines: StructuredEngine[] = [
      executorEngine("ollama", async () => fakeExecutor("ollama", ollamaSeen)),
      executorEngine("webllm", async () => fakeExecutor("webllm", webSeen)),
      builtinEngine(() => fakeChrome(chromeSeen), () => {}),
    ];
    expect(conformanceInputs()).toHaveLength(50);
    expect(SCHEMAS).toHaveLength(5);
    for (const e of engines) {
      const r = await runConformance(e);
      expect(r.total).toBe(250);
      expect(r.rate, `${e.id}: ${JSON.stringify(r.invalid.slice(0, 3))}`).toBeGreaterThanOrEqual(0.9);
    }
    expect(ollamaSeen.every((r) => SCHEMAS.some((s) => s.schema === r.schema))).toBe(true);
    expect(webSeen).toHaveLength(250);
    expect(chromeSeen.every((c) => SCHEMAS.some((s) => s.schema === c))).toBe(true);
  });

  it("through generateStructured (retry on a bad answer) every engine reaches ≥ 98 %", async () => {
    for (const make of [
      () => executorEngine("ollama", async () => fakeExecutor("ollama", [])),
      () => executorEngine("webllm", async () => fakeExecutor("webllm", [])),
      () => builtinEngine(() => fakeChrome([]), () => {}),
    ]) {
      let valid = 0;
      let total = 0;
      for (const s of SCHEMAS) {
        for (const input of conformanceInputs()) {
          total++;
          try {
            const r = await generateStructured({ system: s.instruction, prompt: input.text, schema: s.schema }, { engines: [make()], builtinAllowed: () => true, task: s.short ? "short" : "general" });
            if (checkStructured(JSON.stringify(r.value), s.schema).ok) valid++;
          } catch {
            /* counted as invalid */
          }
        }
      }
      expect(valid / total).toBeGreaterThanOrEqual(0.98);
    }
  });
});

describe("generateStructured", () => {
  const schema: JsonSchema = { type: "object", properties: { n: { type: "integer" } }, required: ["n"] };
  const engine = (id: StructuredEngine["id"], replies: string[], available = true): StructuredEngine & { calls: number } => {
    const e = { id, onDevice: true, calls: 0, available: async () => available, generate: async () => replies[Math.min(e.calls++, replies.length - 1)]! };
    return e;
  };

  it("validates whatever the engine promised, retries once with the error, then moves to the next engine", async () => {
    const a = engine("ollama", ["nope", '{"n":"x"}']);
    const b = engine("webllm", ['{"n": 3}']);
    const r = await generateStructured<{ n: number }>({ prompt: "p", schema }, { engines: [a, b] });
    expect(r).toMatchObject({ value: { n: 3 }, engine: "webllm", attempts: 3 });
    expect(a.calls).toBe(2);
    expect(r.skipped[0]!.reason).toContain("invalid output");
  });

  it("short tasks try the built-in model first only when the gate is open; general tasks use it last", async () => {
    const all = [engine("builtin", ['{"n":1}']), engine("ollama", ['{"n":2}']), engine("webllm", ['{"n":3}'])];
    expect(engineOrder(all, "short").map((e) => e.id)).toEqual(["builtin", "ollama", "webllm"]);
    expect(engineOrder(all, "general").map((e) => e.id)).toEqual(["ollama", "webllm", "builtin"]);
    expect((await generateStructured({ prompt: "p", schema }, { engines: all, task: "short", builtinAllowed: () => true })).engine).toBe("builtin");
    const closed = await generateStructured({ prompt: "p", schema }, { engines: all, task: "short", builtinAllowed: () => false });
    expect(closed.engine).toBe("ollama");
    expect(closed.skipped).toEqual([{ engine: "builtin", reason: "gate" }]);
  });

  it("without Chrome's built-in model (Firefox, Safari, mobile) it falls through to the next engine with no error", async () => {
    for (const g of [{}, { LanguageModel: {} }, { LanguageModel: { availability: async () => "downloadable", create: async () => ({}) } }]) {
      const b = builtinEngine(() => languageModelApi(g), () => {});
      const r = await generateStructured({ prompt: "p", schema }, { engines: [b, engine("ollama", ['{"n":2}'])], task: "short", builtinAllowed: () => true });
      expect(r.engine).toBe("ollama");
      expect(r.skipped).toEqual([{ engine: "builtin", reason: "unavailable" }]);
    }
    expect(await builtinAvailability(fakeChrome([]), { userAgent: "Mozilla/5.0 (Linux; Android 15) Chrome/148 Mobile" })).toBe("unavailable");
    expect(isMobileBrowser({ userAgentData: { mobile: true } })).toBe(true);
    expect(await builtinAvailability(fakeChrome([]), { userAgent: "Mozilla/5.0 (Macintosh) Chrome/148" })).toBe("available");
  });

  it("no engine at all: one clear StructuredOutputError", async () => {
    await expect(generateStructured({ prompt: "p", schema }, { engines: [engine("ollama", [""], false)] })).rejects.toBeInstanceOf(StructuredOutputError);
  });

  it("the built-in engine records each call as on-device", async () => {
    let n = 0;
    const b = builtinEngine(() => fakeChrome([]), () => n++);
    await generateStructured({ prompt: "p", schema }, { engines: [b], builtinAllowed: () => true });
    expect(n).toBe(1);
    expect(b.onDevice).toBe(true);
  });
});

describe("the zero-download gate (≥ 90 % of the local model's Hebrew score)", () => {
  it("is closed until measured, opens at ≥ 90 %, and closes again on another Chrome version", () => {
    expect(builtinGateOpen(localStorage, "148")).toBe(false);
    saveGate({ builtinScore: 0.85, localScore: 0.9, localModel: "qwen", chromeVersion: "148", at: "x" });
    expect(builtinGateOpen(localStorage, "148")).toBe(true); // 0.85 ≥ 0.81
    expect(builtinGateOpen(localStorage, "149")).toBe(false);
    saveGate({ builtinScore: 0.7, localScore: 0.9, localModel: "qwen", chromeVersion: "148", at: "x" });
    expect(builtinGateOpen(localStorage, "148")).toBe(false);
    localStorage.setItem(GATE_KEY, "garbage");
    expect(builtinGateOpen(localStorage, "148")).toBe(false);
  });

  it("runGateEval scores right answers (not only valid ones) on both and records the result", async () => {
    const right = (id: StructuredEngine["id"]): StructuredEngine => ({
      id,
      onDevice: true,
      available: async () => true,
      generate: async (req) => {
        const input = conformanceInputs().find((i) => i.text === req.prompt)!;
        const s = SCHEMAS.find((x) => x.schema === req.schema)!;
        const want = input.want[s.id];
        return JSON.stringify(s.id === "tags" ? { tags: want } : { [s.id]: want });
      },
    });
    const wrong: StructuredEngine = { ...right("builtin"), generate: async (req) => JSON.stringify(answer(req.schema, "zzzzzz")) };
    const g = await runGateEval(wrong, right("ollama"), "qwen2.5:7b", "Chrome/148");
    expect(g.localScore).toBe(1);
    expect(g.builtinScore).toBeLessThan(0.9);
    expect(builtinGateOpen(localStorage, "148")).toBe(false);
    const ok = await runGateEval(right("builtin"), right("ollama"), "qwen2.5:7b", "Chrome/148");
    expect(ok.builtinScore).toBe(1);
    expect(builtinGateOpen(localStorage, "148")).toBe(true);
  });
});
