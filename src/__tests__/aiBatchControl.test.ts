/**
 * Plan 5.8 — a batch job can be paused, resumed (also after a reload) and
 * cancelled; it reports live progress with an ETA; and every answer passes
 * the job's validator, with the critic's retry, before it can be applied.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => ({ aiKey: null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null }) } }));
vi.mock("../store/useToastStore", () => ({ toast: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));

import * as batch from "../ai/batch";
import { validateBatchAnswer } from "../ai/batchValidate";

/** An answerer whose notes finish only when the test says so; it sees the abort signal. */
function controlled() {
  const calls: string[] = [];
  const pending: Array<{ user: string; resolve: (s: string) => void }> = [];
  const answer = (_system: string, user: string, _max: number, ctx?: batch.LocalAnswerContext) =>
    new Promise<string>((resolve, reject) => {
      calls.push(user);
      const entry = { user, resolve };
      // A cancelled note is no longer in flight: it leaves the queue, so finishNext() never resolves it.
      ctx?.signal?.addEventListener("abort", () => {
        const i = pending.indexOf(entry);
        if (i >= 0) pending.splice(i, 1);
        reject(new DOMException("aborted", "AbortError"));
      });
      pending.push(entry);
    });
  /** Resolve the oldest note in flight and let the queue move on. */
  const finishNext = async (text = "a. b.") => {
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    pending.shift()!.resolve(text);
  };
  return { calls, pending, answer, finishNext };
}

const notes = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `n${i}.md`, text: `note number ${i} text` }));

describe("batch control (5.8)", () => {
  beforeEach(() => {
    localStorage.clear();
    batch.__setLocalBatchDeps({ route: async () => ({ executor: "ollama", model: "qwen2.5:7b" }), read: async (p) => `note number ${p.replace(/\D/g, "")} text` });
  });

  it("pause stops after the note in flight is cancelled; a check does not restart it; resume finishes the rest", async () => {
    const a = controlled();
    batch.__setLocalBatchDeps({ answer: a.answer });
    const job = await batch.submitBatch("summary", notes(3));
    await a.finishNext();
    await vi.waitFor(async () => expect((await batch.batchProgress(job)).done).toBe(1));
    await vi.waitFor(() => expect(a.pending).toHaveLength(1));
    await batch.pauseBatch(job.id);
    await batch.__localBatchRun(job.id);
    const paused = await batch.batchProgress(job);
    expect(paused).toMatchObject({ total: 3, done: 1, failed: 0, paused: true, running: false, finished: false, etaMs: null });
    // "Check Batch Jobs" while paused: still processing, and no note starts.
    const callsBefore = a.calls.length;
    expect((await batch.fetchBatchResults(job)).state).toBe("processing");
    expect(a.calls.length).toBe(callsBefore);
    // Resume: the interrupted note runs again, then the last one.
    await batch.resumeBatch(job);
    await a.finishNext();
    await a.finishNext();
    await batch.__localBatchRun(job.id);
    const res = await batch.fetchBatchResults(job);
    expect(res.state).toBe("ended");
    expect(res.answers.size).toBe(3);
    expect(res.failed).toBe(0);
    await batch.clearLocalBatch(job.id);
  });

  it("a paused job is still paused after a reload, and resumes from the missing notes", async () => {
    const a = controlled();
    batch.__setLocalBatchDeps({ answer: a.answer });
    const job = await batch.submitBatch("tags", notes(2));
    await a.finishNext('["one"]');
    await vi.waitFor(async () => expect((await batch.batchProgress(job)).done).toBe(1));
    await batch.pauseBatch(job.id);
    await batch.__localBatchRun(job.id);
    // A reload: this session's memory is gone, IndexedDB is not.
    batch.__forgetSession();
    const after = await batch.batchProgress(job);
    expect(after).toMatchObject({ done: 1, paused: true, finished: false });
    expect((await batch.fetchBatchResults(job)).state).toBe("processing");
    const b = controlled();
    batch.__setLocalBatchDeps({ answer: b.answer });
    await batch.resumeBatch(job);
    await b.finishNext('["two"]');
    await batch.__localBatchRun(job.id);
    expect(b.calls).toEqual(["note number 1 text"]);
    const res = await batch.fetchBatchResults(job);
    expect(res.state).toBe("ended");
    expect([...res.answers.values()]).toEqual(['["one"]', '["two"]']);
    await batch.clearLocalBatch(job.id);
  });

  it("cancel stops the run, the job is cancelled, and nothing of it can be applied", async () => {
    const a = controlled();
    batch.__setLocalBatchDeps({ answer: a.answer });
    const job = await batch.submitBatch("summary", notes(2));
    await vi.waitFor(() => expect(a.pending).toHaveLength(1));
    await batch.cancelBatch(job);
    await batch.__localBatchRun(job.id);
    expect(batch.loadJobs().find((j) => j.id === job.id)?.status).toBe("cancelled");
    const res = await batch.fetchBatchResults(job);
    expect(res).toMatchObject({ state: "cancelled", failed: 0 });
    expect(res.answers.size).toBe(0);
    expect((await batch.batchProgress(job)).cancelled).toBe(true);
    // A resume after a cancel does nothing.
    await batch.resumeBatch(job);
    expect(a.calls).toHaveLength(1);
  });

  it("live progress: listeners hear every note, and the ETA comes from the recent notes", async () => {
    const a = controlled();
    batch.__setLocalBatchDeps({ answer: a.answer });
    const heard = vi.fn();
    const off = batch.subscribeBatch(heard);
    const job = await batch.submitBatch("summary", notes(2));
    expect((await batch.batchProgress(job)).etaMs).toBeNull();
    await a.finishNext();
    await vi.waitFor(async () => expect((await batch.batchProgress(job)).done).toBe(1));
    // The note counts as done in memory first; listeners hear it once its state is stored.
    await vi.waitFor(() => expect(heard).toHaveBeenCalled());
    expect((await batch.batchProgress(job)).etaMs).not.toBeNull();
    await a.finishNext();
    await batch.__localBatchRun(job.id);
    expect((await batch.batchProgress(job))).toMatchObject({ done: 2, finished: true, etaMs: 0 });
    off();
    await batch.clearLocalBatch(job.id);
    expect(batch.estimateEta([1000, 3000], 5)).toBe(10_000);
    expect(batch.estimateEta([], 5)).toBeNull();
    expect(batch.estimateEta([1000], 0)).toBe(0);
  });

  it("a rejected answer is a failed note with its reason, never an answer", async () => {
    batch.__setLocalBatchDeps({ answer: async () => Promise.reject(new Error("summary too long")) });
    const job = await batch.submitBatch("summary", notes(1));
    await batch.__localBatchRun(job.id);
    const p = await batch.batchProgress(job);
    expect(p).toMatchObject({ done: 0, failed: 1, finished: true });
    expect(Object.values(p.rejected)).toEqual(["summary too long"]);
    expect((await batch.fetchBatchResults(job)).answers.size).toBe(0);
    await batch.clearLocalBatch(job.id);
  });
});

describe("the job's validator and critic (5.8)", () => {
  it("rejects answers that don't fit the operation", () => {
    expect(validateBatchAnswer("tags", '["a","b-c"]').ok).toBe(true);
    expect(validateBatchAnswer("tags", "Here are some tags that I think describe this note well").ok).toBe(false);
    expect(validateBatchAnswer("tags", JSON.stringify(Array.from({ length: 11 }, (_, i) => `t${i}`))).ok).toBe(false);
    expect(validateBatchAnswer("summary", "סיכום קצר. ועוד משפט.").ok).toBe(true);
    expect(validateBatchAnswer("summary", "# Title\n- point").ok).toBe(false);
    expect(validateBatchAnswer("summary", "One. Two. Three. Four.").ok).toBe(false);
    const src = "word ".repeat(100);
    expect(validateBatchAnswer("summary", src, src).ok).toBe(false);
    expect(validateBatchAnswer("translate", "same source text here", "same source text here").ok).toBe(false);
    expect(validateBatchAnswer("translate", "short", "x".repeat(400)).ok).toBe(false);
    expect(validateBatchAnswer("translate", "שלום", "hello").ok).toBe(true);
  });

  it("the batch agent retries once with the critic's hint, then accepts", async () => {
    const { registerExecutor, resetExecutors } = await import("../agents/executors");
    const { runAgent } = await import("../agents/runtime");
    const { batchAgent } = await import("../agents/defs");
    const { fakeExecutor, sequence } = await import("./helpers/fakeExecutor");
    resetExecutors();
    const ex = fakeExecutor(sequence("# Heading\n- a list, not a summary", "A plain one-sentence summary."));
    registerExecutor(ex);
    const run = await runAgent(batchAgent, { text: "note", extra: { system: "Summarise.", maxTokens: 200, op: "summary", source: "note" } }, { executor: "ollama", prepaid: true });
    expect(run.status).toBe("ok");
    expect(run.output).toBe("A plain one-sentence summary.");
    expect(ex.calls).toHaveLength(2);
    expect(JSON.stringify(ex.calls[1].messages)).toContain("Markdown in the summary");
    resetExecutors();
  });

  it("an answer that still fails after the retry fails the run (the note is counted as failed)", async () => {
    const { registerExecutor, resetExecutors } = await import("../agents/executors");
    const { runAgent } = await import("../agents/runtime");
    const { batchAgent } = await import("../agents/defs");
    const { fakeExecutor, sequence } = await import("./helpers/fakeExecutor");
    resetExecutors();
    registerExecutor(fakeExecutor(sequence("Sentence one is here and it is fine but. Two. Three. Four. Five.")));
    const run = await runAgent(batchAgent, { text: "note", extra: { system: "Summarise.", maxTokens: 200, op: "summary", source: "note" } }, { executor: "ollama", prepaid: true });
    expect(run.status).not.toBe("ok");
    resetExecutors();
  });
});
