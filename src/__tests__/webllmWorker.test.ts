import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();
const reload = vi.fn(async () => {});
const unload = vi.fn(async () => {});
const interruptGenerate = vi.fn();
const setInitProgressCallback = vi.fn();
let progress: ((r: { progress: number; text: string }) => void) | null = null;
const CreateMLCEngine = vi.fn(async (_model: string, cfg: { initProgressCallback: typeof progress }) => {
  progress = cfg.initProgressCallback;
  return { reload, unload, interruptGenerate, setInitProgressCallback, chat: { completions: { create } } };
});
const hasModelInCache = vi.fn(async (m: string) => m === "cached");
const deleteModelAllInfoInCache = vi.fn(async () => {});
vi.mock("@mlc-ai/web-llm", () => ({ CreateMLCEngine, hasModelInCache, deleteModelAllInfoInCache }));

const posted: unknown[] = [];
vi.stubGlobal("postMessage", (m: unknown) => posted.push(m));

import { handle } from "../ai/webllm.worker";

async function* chunks(parts: Array<Record<string, unknown>>) {
  for (const p of parts) yield p;
}

describe("webllm worker", () => {
  beforeEach(() => {
    posted.length = 0;
    create.mockReset();
    reload.mockClear();
    unload.mockClear();
  });

  it("loads once, reports progress, and reloads to switch models", async () => {
    await handle({ id: 1, type: "load", modelId: "a" });
    progress?.({ progress: 0.5, text: "half" });
    expect(posted).toEqual([{ id: 1, type: "result", value: "a" }, { id: 1, type: "progress", progress: 0.5, text: "half" }]);
    expect(CreateMLCEngine).toHaveBeenCalledTimes(1);
    await handle({ id: 2, type: "load", modelId: "b" });
    expect(reload).toHaveBeenCalledWith("b");
    expect(CreateMLCEngine).toHaveBeenCalledTimes(1);
  });

  it("answers a non-streamed chat with tool calls and usage", async () => {
    create.mockResolvedValue({ model: "b", choices: [{ message: { content: "x", tool_calls: [{ id: "c" }] } }], usage: { prompt_tokens: 3, completion_tokens: 1 } });
    await handle({ id: 3, type: "chat", modelId: "b", request: { messages: [{ role: "user", content: "q" }], temperature: 0 }, stream: false });
    expect(posted).toEqual([{ id: 3, type: "result", value: { content: "x", tool_calls: [{ id: "c" }], model: "b", usage: { prompt_tokens: 3, completion_tokens: 1 } } }]);
    expect(create.mock.calls[0][0]).toMatchObject({ stream: false, temperature: 0 });
  });

  it("streams deltas then the result", async () => {
    create.mockResolvedValue(chunks([{ choices: [{ delta: { content: "He" } }] }, { choices: [{ delta: { content: "y" } }], usage: { prompt_tokens: 2, completion_tokens: 2 } }]));
    await handle({ id: 4, type: "chat", modelId: "b", request: { messages: [] }, stream: true });
    expect(posted).toEqual([
      { id: 4, type: "delta", text: "He" },
      { id: 4, type: "delta", text: "y" },
      { id: 4, type: "result", value: { content: "Hey", tool_calls: [], model: "b", usage: { prompt_tokens: 2, completion_tokens: 2 } } },
    ]);
    expect(create.mock.calls[0][0]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it("turns failures into error messages and handles interrupt / cache / unload", async () => {
    create.mockRejectedValue(new Error("boom"));
    await handle({ id: 5, type: "chat", modelId: "b", request: { messages: [] }, stream: false });
    expect(posted).toEqual([{ id: 5, type: "error", message: "boom" }]);
    posted.length = 0;
    await handle({ id: 6, type: "interrupt" });
    expect(interruptGenerate).toHaveBeenCalled();
    interruptGenerate.mockClear();
    // A targeted interrupt that lands while the chat is still LOADING its
    // model is recorded and ends the chat before it generates.
    let releaseLoad: (() => void) | null = null;
    reload.mockImplementationOnce(() => new Promise<void>((r) => (releaseLoad = r)));
    create.mockResolvedValue({ choices: [{ message: { content: "should not run" } }] });
    const createCallsBefore = create.mock.calls.length;
    const loading = handle({ id: 20, type: "chat", modelId: "other-model", request: { messages: [] }, stream: false });
    await new Promise((r) => setTimeout(r, 0));
    await handle({ id: 21, type: "interrupt", target: 20 });
    expect(interruptGenerate).not.toHaveBeenCalled();
    releaseLoad!();
    await loading;
    expect(posted.at(-1)).toEqual({ id: 20, type: "error", message: "aborted" });
    expect(create.mock.calls.length).toBe(createCallsBefore);
    posted.length = 0;
    create.mockReset();
    // A targeted interrupt for a chat that is not running cancels it when
    // its turn comes, without touching the current generation.
    await handle({ id: 11, type: "interrupt", target: 12 });
    expect(interruptGenerate).not.toHaveBeenCalled();
    create.mockResolvedValue({ choices: [{ message: { content: "never" } }] });
    await handle({ id: 12, type: "chat", modelId: "b", request: { messages: [] }, stream: false });
    expect(posted.at(-1)).toEqual({ id: 12, type: "error", message: "aborted" });
    posted.length = 0;
    await handle({ id: 7, type: "hasModel", modelId: "cached" });
    // The loaded model is now "other-model" (the cancelled chat switched to it).
    await handle({ id: 8, type: "deleteModel", modelId: "other-model" });
    expect(unload).toHaveBeenCalledTimes(1);
    expect(deleteModelAllInfoInCache).toHaveBeenCalledWith("other-model");
    await handle({ id: 9, type: "unload" });
    expect(posted).toEqual([
      { id: 7, type: "result", value: true },
      { id: 8, type: "result", value: true },
      { id: 9, type: "result", value: true },
    ]);
    // After unload a chat creates a fresh engine.
    create.mockResolvedValue({ choices: [{ message: { content: "again" } }] });
    await handle({ id: 10, type: "chat", modelId: "b", request: { messages: [] }, stream: false });
    expect(CreateMLCEngine).toHaveBeenCalledTimes(2);
  });
});
