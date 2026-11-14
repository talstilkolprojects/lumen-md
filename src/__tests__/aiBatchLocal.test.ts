import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => ({ aiKey: null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null }) } }));
const idbFlags = vi.hoisted(() => ({ failSet: false }));
vi.mock("idb-keyval", async (orig) => {
  const real = await orig<typeof import("idb-keyval")>();
  return { ...real, set: (...a: Parameters<typeof real.set>) => (idbFlags.failSet ? Promise.reject(new Error("QuotaExceeded")) : real.set(...a)) };
});
vi.mock("../store/useToastStore", () => ({ toast: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import * as batch from "../ai/batch";

describe("local batch queue", () => {
  beforeEach(() => {
    localStorage.clear();
    batch.__setLocalBatchDeps({ route: async () => ({ executor: "ollama", model: "qwen2.5:7b" }) });
  });

  it("is the batch provider under local policies; the cloud Batch API only under cloud", () => {
    expect(batch.batchProviderFor("ollama")).toBe("local");
    expect(batch.batchProviderFor("anthropic")).toBe("local");
    localStorage.setItem("lumen.ai.policy", "cloud");
    expect(batch.batchProviderFor("anthropic")).toBe("anthropic");
    expect(batch.batchProviderFor("gemini")).toBeNull();
  });

  it("answers each note with the batch prompts, records failures, and reports processing until done", async () => {
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    batch.__setLocalBatchDeps({
      answer: async (_system, user) => {
        seen.push(user);
        await gate;
        if (user.includes("boom")) throw new Error("model failed");
        return `summary of ${user.slice(0, 5)}`;
      },
      read: async () => null,
    });
    const job = await batch.submitBatch("summary", [
      { path: "a.md", text: "alpha text" },
      { path: "b.md", text: "boom text" },
    ]);
    expect(batch.loadJobs().some((j) => j.id === job.id)).toBe(true);
    expect((await batch.fetchBatchResults(job)).state).toBe("processing");
    release();
    await batch.__localBatchRun(job.id);
    const res = await batch.fetchBatchResults(job);
    expect(res.state).toBe("ended");
    expect(res.failed).toBe(1);
    expect(res.answers.get("n0")).toBe("summary of alpha");
    expect(seen).toHaveLength(2);
  });

  it("resumes an interrupted job from the workspace, only for missing notes", async () => {
    const answered: string[] = [];
    batch.__setLocalBatchDeps({
      answer: async (_s, user) => {
        answered.push(user);
        return "ok";
      },
      read: async (path) => (path === "c.md" ? "gamma text" : null),
    });
    const job: batch.BatchJob = { id: "local_resume", provider: "local", model: "m", op: "tags", createdAt: "", items: [{ customId: "n0", path: "c.md", hash: batch.textHash("gamma text") }], status: "submitted" };
    batch.saveJobs([job]);
    expect((await batch.fetchBatchResults(job)).state).toBe("processing");
    await batch.__localBatchRun(job.id);
    expect((await batch.fetchBatchResults(job)).answers.get("n0")).toBe("ok");
    expect(answered).toEqual(["gamma text"]);
    await batch.clearLocalBatch(job.id);
  });

  it("never leaves the device: the default answerer uses only Ollama / the in-browser model, and pauses when neither is there", async () => {
    const { registerExecutor, resetExecutors } = await import("../agents/executors");
    resetExecutors();
    const off = { available: async () => ({ available: false, reason: "offline" }) };
    const chat = vi.fn();
    registerExecutor({ id: "ollama", label: "o", supportsTools: () => false, supportsSchema: () => false, modelFor: () => "m", chat, ...off });
    registerExecutor({ id: "webllm", label: "w", supportsTools: () => false, supportsSchema: () => false, modelFor: () => "m", chat, ...off });
    expect(await batch.localBatchRoute()).toBeNull();
    // A cloud-capable chat executor is never consulted.
    const cloud = vi.fn();
    registerExecutor({ id: "chat", label: "c", supportsTools: () => false, supportsSchema: () => false, modelFor: () => "gpt", chat: cloud, available: async () => ({ available: true }) });
    expect(await batch.localBatchRoute()).toBeNull();
    registerExecutor({ id: "ollama", label: "o", supportsTools: () => false, supportsSchema: () => false, modelFor: () => "qwen2.5:7b", chat, available: async () => ({ available: true }) });
    expect(await batch.localBatchRoute()).toEqual({ executor: "ollama", model: "qwen2.5:7b" });
    expect(cloud).not.toHaveBeenCalled();
    resetExecutors();
  });

  it("Esc / AI: Cancel stops the note in flight; the job resumes from it on the next check (T55)", async () => {
    const { cancelAllAi } = await import("../ai/aiAbort");
    let calls = 0;
    batch.__setLocalBatchDeps({
      answer: (_s, user, _m, signal) =>
        new Promise<string>((resolve, reject) => {
          calls++;
          if (calls > 1) return resolve(`done ${user.slice(0, 4)}`);
          signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")));
        }),
      read: async () => "xray text",
    });
    const job = await batch.submitBatch("summary", [{ path: "x.md", text: "xray text" }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(cancelAllAi()).toBeGreaterThan(0);
    await batch.__localBatchRun(job.id);
    const paused = await batch.fetchBatchResults(job);
    expect(paused.state).toBe("processing");
    expect(paused.failed).toBe(0);
    await batch.__localBatchRun(job.id);
    const res = await batch.fetchBatchResults(job);
    expect(res.state).toBe("ended");
    expect(res.answers.get("n0")).toBe("done xray");
    await batch.clearLocalBatch(job.id);
  });

  it("a job with no local model pauses (not failed) and says what to do on the next check", async () => {
    batch.__setLocalBatchDeps({
      answer: async () => {
        throw new batch.NoLocalModelError();
      },
      read: async () => "text",
    });
    const job = await batch.submitBatch("tags", [{ path: "p.md", text: "some text here" }]);
    await batch.__localBatchRun(job.id);
    await expect(batch.fetchBatchResults(job)).rejects.toThrow(/No local model/);
  });

  it("keeps a finished job's answers for this session when IndexedDB refuses them, and forgets them once applied", async () => {
    idbFlags.failSet = true;
    batch.__setLocalBatchDeps({ answer: async () => "answer", read: async () => "t" });
    const job = await batch.submitBatch("summary", [{ path: "q.md", text: "quota text" }]);
    await batch.__localBatchRun(job.id);
    const res = await batch.fetchBatchResults(job);
    expect(res.state).toBe("ended");
    expect(res.answers.get("n0")).toBe("answer");
    idbFlags.failSet = false;
    await batch.clearLocalBatch(job.id);
  });
});
