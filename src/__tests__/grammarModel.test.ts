// @vitest-environment node
/**
 * Plan W10.B9 (audit W5.3): the grammar model step runs in the shipped app.
 * setupGrammarRanker registers ollamaGrammarRanker when the user turned the
 * model on and Ollama on this computer has a Hebrew model. rankFindings
 * caps the model at 300 ms per check. With the setting off nothing is
 * requested and the rules' findings come back unchanged.
 *
 * The real checker, ranker and setup run. Only Ollama itself (the HTTP
 * boundary) is replaced, by a fetch that answers like Ollama's /api/tags
 * and /api/generate.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { hebrewGrammar } from "../ai/hebrewGrammar";
import { hasGrammarRanker, rankFindings, RANK_BUDGET_MS, registerGrammarRanker } from "../ai/grammarRanker";
import { pickGrammarModel, setupGrammarRanker } from "../ai/grammarModel";

const TEXT = "נפגשתי את דני. קנינו שתי ספרים.";
const found = () => hebrewGrammar(TEXT);

function fakeOllama(models: string[], answer: (prompt: string) => string, delayMs = 0) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/api/tags")) return new Response(JSON.stringify({ models: models.map((name) => ({ name })) }));
    if (url.endsWith("/api/generate")) {
      const { prompt } = JSON.parse(String(init?.body)) as { prompt: string };
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return new Response(JSON.stringify({ response: answer(prompt) }));
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

afterEach(() => registerGrammarRanker(null));

describe("setupGrammarRanker (W10.B9)", () => {
  it("off: no request and no ranker, and the findings are identical", async () => {
    const o = fakeOllama(["dictalm3:1.7b"], () => "B");
    expect(await setupGrammarRanker({ enabled: false, baseUrl: "http://localhost:11434", fetchImpl: o.impl })).toEqual({ registered: false, reason: "off" });
    expect(o.calls).toEqual([]);
    expect(hasGrammarRanker()).toBe(false);
    expect(await rankFindings(TEXT, found())).toEqual(found());
  });

  it("on, with a Hebrew model in Ollama: registers it, and the model's verdicts change what is shown", async () => {
    // The model accepts the עם fix and rejects the שני fix.
    const o = fakeOllama(["llama3:8b", "hf.co/dicta-il/DictaLM-3.0-1.7B-Thinking-GGUF"], (p) => (p.includes("עם דני") ? "B" : "A"));
    const r = await setupGrammarRanker({ enabled: true, baseUrl: "http://localhost:11434", fetchImpl: o.impl });
    expect(r).toEqual({ registered: true, model: "hf.co/dicta-il/DictaLM-3.0-1.7B-Thinking-GGUF" });
    expect(hasGrammarRanker()).toBe(true);
    const before = found().map((m) => m.rule.id);
    const after = (await rankFindings(TEXT, found())).map((m) => m.rule.id);
    expect(before).toEqual(["HE_ET_IM", "HE_TWO_GENDER"]);
    expect(after).toEqual(["HE_ET_IM"]);
    expect(o.calls.filter((u) => u.endsWith("/api/generate"))).toHaveLength(2);
  });

  it("a model slower than the budget leaves the rules' findings as they are", async () => {
    expect(RANK_BUDGET_MS).toBe(300);
    const o = fakeOllama(["dictalm3"], () => "A", 2_000);
    await setupGrammarRanker({ enabled: true, baseUrl: "http://127.0.0.1:11434", fetchImpl: o.impl });
    const t0 = performance.now();
    const kept = await rankFindings(TEXT, found());
    const ms = performance.now() - t0;
    expect(kept).toEqual(found());
    expect(ms).toBeLessThan(1_500);
  });

  it("refuses a non-local Ollama, and registers nothing without Ollama or a Hebrew model", async () => {
    const o = fakeOllama(["dictalm3"], () => "B");
    expect(await setupGrammarRanker({ enabled: true, baseUrl: "http://192.168.1.5:11434", fetchImpl: o.impl })).toEqual({ registered: false, reason: "not-local" });
    expect(o.calls).toEqual([]);
    const down = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    expect(await setupGrammarRanker({ enabled: true, baseUrl: "http://localhost:11434", fetchImpl: down })).toEqual({ registered: false, reason: "no-ollama" });
    const none = fakeOllama(["llama3:8b"], () => "B");
    expect(await setupGrammarRanker({ enabled: true, baseUrl: "http://localhost:11434", fetchImpl: none.impl })).toEqual({ registered: false, reason: "no-hebrew-model" });
    expect(hasGrammarRanker()).toBe(false);
  });

  it("picks DictaLM first, then a model with strong Hebrew", () => {
    expect(pickGrammarModel(["aya-expanse:8b", "dictalm3:1.7b"])).toBe("dictalm3:1.7b");
    expect(pickGrammarModel(["llama3:8b"])).toBeNull();
  });

  it("the shipped app calls it: App.tsx runs setupGrammarRanker, which calls registerGrammarRanker", () => {
    expect(readFileSync("src/App.tsx", "utf8")).toMatch(/import\("\.\/ai\/grammarModel"\)\.then\(\(m\) => m\.setupGrammarRanker\(\)\)/);
    expect(readFileSync("src/ai/grammarModel.ts", "utf8")).toMatch(/registerGrammarRanker\(ollamaGrammarRanker\(/);
    expect(readFileSync("src/commands/domains/tools.ts", "utf8")).toContain('id: "view.hebrewGrammarModel"');
  });
});
