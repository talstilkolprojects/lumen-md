import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state = { aiKey: "sk", useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null };
vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => state, setState: vi.fn() } }));
vi.mock("../store/useToastStore", () => ({ toast: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../ui/AiToast", () => ({ showAiToast: vi.fn() }));
vi.mock("../lib/logger", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

/**
 * Every path that sends content to a third party outside chat() must stop
 * under the local-only policy before any request goes out.
 */
describe("AI policy gates on direct cloud paths", () => {
  const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 200 }));
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("lumen.ai.policy", "local-only");
    vi.stubGlobal("fetch", fetchSpy);
    fetchSpy.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("transcription: under local-only the cloud Whisper API is never contacted; local-first falls back to it", async () => {
    const { transcribe } = await import("../ai/transcribe");
    // Local by default: in jsdom the local path fails (no Web Audio) and that is final.
    await expect(transcribe(new Blob(["x"]))).rejects.toThrow(/Web Audio/);
    expect(fetchSpy).not.toHaveBeenCalled();
    localStorage.setItem("lumen.ai.policy", "local-first");
    vi.stubGlobal("fetch", fetchSpy);
    await expect(transcribe(new Blob(["x"]))).rejects.toThrow();
    // The fallback would reach OpenAI; with a key it does — proving the gate is the policy, not luck.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain("api.openai.com");
  });

  it("the public LanguageTool API is never contacted; background checks spell English on this device only", async () => {
    const { checkGrammar } = await import("../ai/grammar");
    expect(await checkGrammar("This are a sentence with enough words to be checked by the tool.")).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    const { isLocalOrigin } = await import("../ai/policy");
    expect(isLocalOrigin("http://localhost:8010/v2/check")).toBe(true);
  });

  it("batch jobs run in the local queue under local-only; the cloud Batch API is refused", async () => {
    localStorage.setItem("lumen.ai.provider", "openai");
    const batch = await import("../ai/batch");
    batch.__setLocalBatchDeps({ answer: async () => '["local-tag"]', read: async () => "hello world", route: async () => ({ executor: "ollama", model: "qwen2.5:7b" }) });
    const job = await batch.submitBatch("tags", [{ path: "a.md", text: "hello world" }], { lang: "he" });
    expect(job.provider).toBe("local");
    await batch.__localBatchRun(job.id);
    const res = await batch.fetchBatchResults(job);
    expect(res).toMatchObject({ state: "ended", failed: 0 });
    expect(res.answers.get("n0")).toBe('["local-tag"]');
    await expect(batch.fetchBatchResults({ id: "b", provider: "openai", model: "m", op: "translate", createdAt: "", items: [], status: "submitted" } as never)).rejects.toMatchObject({ code: "POLICY" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fine-tuning (uploads the user's writing)", async () => {
    const { startFineTune, getFineTuneJob } = await import("../ai/fineTune");
    await expect(startFineTune()).rejects.toMatchObject({ code: "POLICY" });
    await expect(getFineTuneJob("ft-1")).rejects.toMatchObject({ code: "POLICY" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("OpenAI embeddings are refused under local-only (smart search itself runs locally)", async () => {
    const { __providers } = await import("../ai/embeddingProvider");
    await expect(__providers.openAiProvider.embed(["x"], "passage")).rejects.toMatchObject({ code: "POLICY" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Claude web search and a remote research service fall back to the library (T34); a local research service is fine", async () => {
    localStorage.setItem("lumen.ai.provider", "anthropic");
    localStorage.setItem("lumen.research.provider", "claude");
    const { runResearch } = await import("../research/agent");
    // Under local-only, research uses the library — empty here — and never the web.
    await expect(runResearch({ question: "q" } as never)).rejects.toThrow(/library/);
    localStorage.setItem("lumen.research.provider", "brave");
    localStorage.setItem("lumen.research.endpoint", "https://research.example.workers.dev");
    await expect(runResearch({ question: "q" } as never)).rejects.toThrow(/library/);
    expect(fetchSpy).not.toHaveBeenCalled();
    // A local research service (a SearXNG on this machine) is not the cloud: the
    // agent runs (and fails here for want of a model, not on the policy).
    localStorage.setItem("lumen.research.endpoint", "http://localhost:8080");
    const local = await runResearch({ question: "q" } as never).catch((e: Error) => e);
    expect((local as { code?: string }).code).not.toBe("POLICY");
    // Only this machine was asked (the runtime probing for a local model); nothing left it.
    expect(fetchSpy.mock.calls.map(([u]) => String(u)).filter((u) => !/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u))).toEqual([]);
  });
});
