import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WorkerIn, WorkerOut } from "../ai/webllm.worker";
import {
  webLlmChat,
  loadWebLlmModel,
  onWebLlmProgress,
  loadedWebLlmModel,
  webLlmModelCached,
  deleteWebLlmModel,
  unloadWebLlm,
  interruptWebLlm,
  __resetWebLlmEngine,
} from "../ai/webllmEngine";

/** A fake worker that answers each request through `script`. */
let script: (msg: WorkerIn, reply: (out: WorkerOut) => void) => void;
let created = 0;
const terminate = vi.fn();
let received: WorkerIn[] = [];

class FakeWorker {
  onmessage: ((ev: MessageEvent<WorkerOut>) => void) | null = null;
  onerror: ((ev: { message: string }) => void) | null = null;
  terminate = terminate;
  constructor(public url: URL) {
    created++;
    (globalThis as unknown as { __lastWorker?: FakeWorker }).__lastWorker = this;
  }
  postMessage(msg: WorkerIn) {
    received.push(msg);
    queueMicrotask(() => script(msg, (out) => this.onmessage?.({ data: out } as MessageEvent<WorkerOut>)));
  }
}

describe("webllmEngine (worker client)", () => {
  beforeEach(() => {
    __resetWebLlmEngine();
    created = 0;
    received = [];
    terminate.mockClear();
    vi.stubGlobal("Worker", FakeWorker);
    script = (msg, reply) => reply({ id: msg.id, type: "result", value: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("creates one worker and routes a non-streamed chat", async () => {
    script = (msg, reply) => {
      if (msg.type === "chat") reply({ id: msg.id, type: "result", value: { content: "hi", tool_calls: [], model: msg.modelId, usage: { prompt_tokens: 1, completion_tokens: 2 } } });
    };
    const res = await webLlmChat("m1", { messages: [{ role: "user", content: "x" }] });
    expect(res).toEqual({ content: "hi", tool_calls: [], model: "m1", usage: { prompt_tokens: 1, completion_tokens: 2 } });
    expect(received[0]).toMatchObject({ type: "chat", modelId: "m1", stream: false });
    await webLlmChat("m1", { messages: [] });
    expect(created).toBe(1);
    expect(loadedWebLlmModel()).toBe("m1");
  });

  it("streams deltas to the callback before the result", async () => {
    script = (msg, reply) => {
      if (msg.type !== "chat") return;
      reply({ id: msg.id, type: "delta", text: "He" });
      reply({ id: msg.id, type: "delta", text: "llo" });
      reply({ id: msg.id, type: "result", value: { content: "Hello", tool_calls: [], model: "m" } });
    };
    const deltas: string[] = [];
    const res = await webLlmChat("m", { messages: [] }, { onDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual(["He", "llo"]);
    expect(res.content).toBe("Hello");
    expect(received[0]).toMatchObject({ stream: true });
  });

  it("reports load progress to listeners and rejects on worker errors", async () => {
    script = (msg, reply) => {
      if (msg.type === "load") {
        reply({ id: msg.id, type: "progress", progress: 0.4, text: "downloading" });
        reply({ id: msg.id, type: "result", value: msg.modelId });
      }
      if (msg.type === "chat") reply({ id: msg.id, type: "error", message: "OOM" });
    };
    const seen: number[] = [];
    const off = onWebLlmProgress((p) => seen.push(p.progress));
    await loadWebLlmModel("big");
    off();
    expect(seen).toEqual([0.4]);
    expect(loadedWebLlmModel()).toBe("big");
    await expect(webLlmChat("big", { messages: [] })).rejects.toThrow("OOM");
  });

  it("rejects an aborted call, targets the interrupt at it, and drops its late result", async () => {
    const late: { fn?: () => void } = {};
    script = (msg, reply) => {
      if (msg.type === "chat") {
        ctrl.abort();
        late.fn = () => reply({ id: msg.id, type: "result", value: { content: "partial", tool_calls: [], model: "m" } });
      } else reply({ id: msg.id, type: "result", value: true });
    };
    const ctrl = new AbortController();
    await expect(webLlmChat("m", { messages: [] }, { signal: ctrl.signal })).rejects.toMatchObject({ name: "AbortError" });
    late.fn?.();
    const chatId = received[0].id;
    expect(received.map((m) => m.type)).toEqual(["chat", "interrupt"]);
    expect((received[1] as { target?: number }).target).toBe(chatId);
    const aborted = new AbortController();
    aborted.abort();
    await expect(webLlmChat("m", { messages: [] }, { signal: aborted.signal })).rejects.toMatchObject({ name: "AbortError" });
    // No worker yet → interrupt is a no-op.
    __resetWebLlmEngine();
    interruptWebLlm();
    expect(created).toBe(1);
  });

  it("discards a worker that failed at the top level so the next call starts a fresh one", async () => {
    script = () => {};
    const p = webLlmChat("m", { messages: [] });
    const w = (globalThis as unknown as { __lastWorker?: FakeWorker }).__lastWorker;
    expect(w).toBeTruthy();
    w!.onerror?.({ message: "module load failed" });
    await expect(p).rejects.toThrow(/module load failed/);
    expect(terminate).toHaveBeenCalledTimes(1);
    script = (msg, reply) => reply({ id: msg.id, type: "result", value: true });
    await webLlmModelCached("x");
    expect(created).toBe(2);
  });

  it("checks and deletes cached models, and unloads by terminating the worker", async () => {
    script = (msg, reply) => {
      if (msg.type === "hasModel") reply({ id: msg.id, type: "result", value: msg.modelId === "cached" });
      else reply({ id: msg.id, type: "result", value: true });
    };
    expect(await webLlmModelCached("cached")).toBe(true);
    expect(await webLlmModelCached("other")).toBe(false);
    await loadWebLlmModel("cached");
    await deleteWebLlmModel("cached");
    expect(loadedWebLlmModel()).toBeNull();
    await unloadWebLlm();
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(received.at(-1)?.type).toBe("unload");
    // After unload a new worker is created on demand.
    await webLlmModelCached("x");
    expect(created).toBe(2);
  });
});
