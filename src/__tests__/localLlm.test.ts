/**
 * Tests for the local LLM availability check. The actual WebGPU + model
 * download paths can't be exercised in jsdom, but `localLlmAvailable()`
 * gates the rest of the code, so we pin its branches.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { localLlmAvailable, onLocalLlmProgress, unloadLocalLlm } from "../ai/localLlm";

describe("localLlmAvailable", () => {
  const originalNavigator = globalThis.navigator;

  beforeEach(() => {
    unloadLocalLlm();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
    });
  });

  it("returns unavailable when WebGPU is missing", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      configurable: true,
    });
    const status = localLlmAvailable();
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/WebGPU/);
  });

  it("returns available when WebGPU is present", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { gpu: {} },
      configurable: true,
    });
    expect(localLlmAvailable().available).toBe(true);
  });

  it("onLocalLlmProgress returns an unsubscribe function", () => {
    const off = onLocalLlmProgress(() => {});
    expect(typeof off).toBe("function");
    off();
  });
});

describe("chatLocal / chatLocalStream", () => {
  it("run through the worker client with the model manager's default", async () => {
    vi.resetModules();
    const webLlmChat = vi.fn(async (_m: string, _r: unknown, opts: { onDelta?: (t: string) => void }) => {
      opts.onDelta?.("a");
      opts.onDelta?.("b");
      return { content: " ab ", tool_calls: [], model: "m" };
    });
    vi.doMock("../ai/webllmEngine", () => ({ webLlmChat, onWebLlmProgress: () => () => {}, unloadWebLlm: async () => {} }));
    vi.doMock("../ai/modelManager", () => ({ detectHardware: async () => ({}), webLlmModelFor: () => "Pick-q4f16_1-MLC" }));
    Object.defineProperty(globalThis, "navigator", { value: { gpu: {} }, configurable: true });
    const { chatLocal, chatLocalStream } = await import("../ai/localLlm");
    expect(await chatLocal([{ role: "user", content: "x" }], { maxTokens: 5 })).toBe("ab");
    expect(webLlmChat.mock.calls[0][0]).toBe("Pick-q4f16_1-MLC");
    expect(webLlmChat.mock.calls[0][1]).toEqual({ messages: [{ role: "user", content: "x" }], max_tokens: 5 });
    const out: string[] = [];
    for await (const c of chatLocalStream([{ role: "user", content: "x" }], { model: "Own" })) out.push(c);
    expect(out).toEqual(["a", "b"]);
    expect(webLlmChat.mock.calls[1][0]).toBe("Own");
    // Closing the generator early aborts the worker call.
    let seenSignal: AbortSignal | undefined;
    webLlmChat.mockImplementationOnce(async (_m: string, _r: unknown, opts: { onDelta?: (t: string) => void; signal?: AbortSignal }) => {
      seenSignal = opts.signal;
      opts.onDelta?.("first");
      await new Promise((r) => setTimeout(r, 20));
      opts.onDelta?.("second");
      return { content: "first second", tool_calls: [], model: "m" };
    });
    const gen = chatLocalStream([{ role: "user", content: "x" }], { model: "Own" });
    expect((await gen.next()).value).toBe("first");
    await gen.return(undefined);
    expect(seenSignal?.aborted).toBe(true);
    webLlmChat.mockRejectedValueOnce(new Error("gpu lost"));
    await expect((async () => {
      for await (const _c of chatLocalStream([{ role: "user", content: "x" }])) void _c;
    })()).rejects.toThrow("gpu lost");
    vi.doUnmock("../ai/webllmEngine");
    vi.doUnmock("../ai/modelManager");
  });
});
