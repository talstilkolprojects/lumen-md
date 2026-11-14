import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => ({ aiKey: null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null }) } }));
vi.mock("../store/useToastStore", () => ({ toast: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));

import { registerExecutor, resetExecutors } from "../agents/executors";
import { fakeExecutor, sequence } from "./helpers/fakeExecutor";
import { locateIssues } from "../agents/defs";
import { checkGrammar, clearGrammarCache, grammarEndpoint, GRAMMAR_ENDPOINT_KEY, __grammarCacheSize } from "../ai/grammar";

const TEXT = "This are a sentence that have two mistakes, and it is long enough for a check.";

beforeEach(() => {
  resetExecutors();
  clearGrammarCache();
  localStorage.clear();
  localStorage.setItem("lumen.ai.cache", "off");
});

describe("proofreader", () => {
  it("locates quoted issues deterministically, skipping absent quotes and no-op fixes", () => {
    expect(locateIssues([{ quote: "have", message: "agreement", replacement: "has" }, { quote: "This are", message: "agreement", replacement: "This is" }, { quote: "nope", message: "x" }, { quote: "a", message: "same", replacement: "a" }], TEXT)).toEqual([
      { offset: 0, length: 8, message: "agreement", replacements: ["This is"] },
      { offset: 25, length: 4, message: "agreement", replacements: ["has"] },
    ]);
  });

  it("an explicit check under local-only uses the local model; offsets come from the text", async () => {
    const ex = fakeExecutor(sequence('{"issues": [{"quote": "This are", "message": "Use \\"is\\"", "replacement": "This is"}]}'));
    registerExecutor(ex);
    const matches = await checkGrammar(TEXT, "en-US", { allowModel: true });
    expect(matches).toEqual([{ offset: 0, length: 8, message: 'Use "is"', replacements: ["This is"], rule: { id: "LOCAL_MODEL", category: "local" } }]);
    expect(ex.calls[0].messages[0].content).toContain("proofreader for en-US");
  });

  it("uses a LanguageTool on this machine when configured, under every policy", async () => {
    localStorage.setItem(GRAMMAR_ENDPOINT_KEY, "http://localhost:8010/v2/check");
    expect(grammarEndpoint()).toBe("http://localhost:8010/v2/check");
    const f = vi.fn(async () => new Response(JSON.stringify({ matches: [{ offset: 0, length: 8, message: "m", replacements: [{ value: "This is" }], rule: { id: "R" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    try {
      const m = await checkGrammar(TEXT);
      expect(m[0]).toMatchObject({ offset: 0, replacements: ["This is"], rule: { id: "R" } });
      expect(String((f.mock.calls[0] as unknown[])[0])).toBe("http://localhost:8010/v2/check");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the proofreader path keeps the cache within its limit", async () => {
    clearGrammarCache();
    localStorage.setItem("lumen.ai.policy", "local-only");
    registerExecutor(fakeExecutor(sequence('{"issues": []}')));
    for (let i = 0; i < 20; i++) await checkGrammar(`Document number ${i} has enough words to be checked by the proofreader.`, "en-US", { allowModel: true });
    expect(__grammarCacheSize()).toBeLessThanOrEqual(16);
  });
});
