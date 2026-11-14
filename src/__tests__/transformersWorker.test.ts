import { describe, it, expect, vi, beforeEach } from "vitest";

const { asrCall, embedCall, dispose, pipelineFn, env } = vi.hoisted(() => {
  const asrCall = vi.fn();
  const embedCall = vi.fn();
  const dispose = vi.fn(async () => {});
  const pipelineFn = vi.fn(async (task: string, _model: string, opts: { progress_callback?: (i: unknown) => void }) => {
    opts.progress_callback?.({ status: "progress", file: "model.onnx", progress: 42, loaded: 42, total: 100 });
    opts.progress_callback?.({ status: "done", file: "model.onnx" });
    const fn = task === "automatic-speech-recognition" ? asrCall : embedCall;
    const pipe = (input: unknown, kwargs: unknown) => fn(input, kwargs);
    (pipe as unknown as { dispose: typeof dispose }).dispose = dispose;
    return pipe;
  });
  const env = { allowLocalModels: true, useBrowserCache: false, useWasmCache: false, backends: { onnx: { wasm: { wasmPaths: undefined as unknown } } } };
  return { asrCall, embedCall, dispose, pipelineFn, env };
});
vi.mock("@huggingface/transformers", () => ({ env, pipeline: pipelineFn }));

const posted: unknown[] = [];
vi.stubGlobal("postMessage", (m: unknown) => posted.push(m));

import { handle, configureOrt, windowsOf } from "../ai/transformers.worker";

describe("transformers worker", () => {
  beforeEach(() => {
    posted.length = 0;
    pipelineFn.mockClear();
    asrCall.mockReset();
    embedCall.mockReset();
    dispose.mockClear();
  });

  it("points ONNX Runtime at the same-origin wasm and uses the browser caches", () => {
    configureOrt("https://lumen-md.vercel.app/ort/");
    expect(env.allowLocalModels).toBe(false);
    expect(env.useBrowserCache).toBe(true);
    expect(env.useWasmCache).toBe(true);
    expect(env.backends.onnx.wasm.wasmPaths).toEqual({
      mjs: "https://lumen-md.vercel.app/ort/ort-wasm-simd-threaded.asyncify.mjs",
      wasm: "https://lumen-md.vercel.app/ort/ort-wasm-simd-threaded.asyncify.wasm",
    });
    configureOrt("/ort/", "");
    expect((env.backends.onnx.wasm.wasmPaths as { wasm: string }).wasm).toBe("/ort/ort-wasm-simd-threaded.wasm");
  });

  it("transcribes with the WebGPU dtype split, forwards progress, and cuts long audio into one call per window", async () => {
    asrCall.mockResolvedValue({ text: " hello ", language: "en" });
    await handle({ id: 1, type: "transcribe", model: "onnx-community/whisper-small", device: "webgpu", audio: new Float32Array(16_000 * 40), language: "en" });
    expect(pipelineFn.mock.calls[0][0]).toBe("automatic-speech-recognition");
    expect(pipelineFn.mock.calls[0][2]).toMatchObject({ device: "webgpu", dtype: { encoder_model: "fp32", decoder_model_merged: "q4" } });
    // 40 s → two windows, two plain calls: never the library's chunk_length_s path.
    expect(asrCall).toHaveBeenCalledTimes(2);
    expect(asrCall.mock.calls[0][1]).toEqual({ language: "en", task: "transcribe" });
    expect(posted).toEqual([
      { id: 1, type: "progress", file: "model.onnx", progress: 42, loaded: 42, total: 100 },
      { id: 1, type: "result", value: { text: "hello hello", language: "en" } },
    ]);
    // Same model + device → the pipeline is reused; a short clip is one call.
    posted.length = 0;
    asrCall.mockReset();
    asrCall.mockResolvedValue([{ text: "a" }, { text: "b" }]);
    await handle({ id: 2, type: "transcribe", model: "onnx-community/whisper-small", device: "webgpu", audio: new Float32Array(16_000) });
    expect(pipelineFn).toHaveBeenCalledTimes(1);
    expect(asrCall).toHaveBeenCalledTimes(1);
    expect(asrCall.mock.calls[0][1]).toEqual({ task: "transcribe" });
    expect(posted).toEqual([{ id: 2, type: "result", value: { text: "a b" } }]);
    // Switching device disposes the old pipeline and loads q8 for wasm.
    await handle({ id: 3, type: "transcribe", model: "onnx-community/whisper-tiny", device: "wasm", audio: new Float32Array(10) });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(pipelineFn.mock.calls[1][2]).toMatchObject({ device: "wasm", dtype: "q8" });
  });

  it("cuts windows at the quietest point near the boundary and keeps every sample", () => {
    const audio = new Float32Array(16_000 * 65).fill(0.5);
    // Silence at 29 s and at 58 s (inside the ±2 s slack of each 30 s target): the cuts land there.
    audio.fill(0, 16_000 * 29, 16_000 * 29 + 2000);
    audio.fill(0, 16_000 * 58, 16_000 * 58 + 2000);
    const w = windowsOf(audio);
    expect(w.length).toBe(3);
    expect(w.reduce((n, x) => n + x.length, 0)).toBe(audio.length);
    expect(Math.round(w[0].length / 16_000)).toBe(29);
    expect(Math.round((w[0].length + w[1].length) / 16_000)).toBe(58);
    expect(windowsOf(new Float32Array(10))).toHaveLength(1);
  });

  it("skips a cancelled queued job and discards the result of a cancelled running one", async () => {
    let release: (() => void) | null = null;
    embedCall.mockImplementationOnce(() => new Promise((r) => (release = () => r({ tolist: () => [[1]] }))));
    const running = handle({ id: 30, type: "embed", model: "m", device: "wasm", texts: ["a"] });
    const queued = handle({ id: 31, type: "embed", model: "m", device: "wasm", texts: ["b"] });
    await new Promise((r) => setTimeout(r, 0));
    await handle({ id: 32, type: "cancel", target: 30 });
    await handle({ id: 33, type: "cancel", target: 31 });
    release!();
    await running;
    await queued;
    expect(posted.filter((p) => (p as { id: number; type: string }).id === 30 && (p as { type: string }).type !== "progress")).toEqual([{ id: 30, type: "error", message: "aborted" }]);
    expect(posted.filter((p) => (p as { id: number }).id === 31)).toEqual([{ id: 31, type: "error", message: "aborted" }]);
    expect(embedCall).toHaveBeenCalledTimes(1);
    posted.length = 0;
    embedCall.mockReset();
  });

  it("embeds with mean pooling + normalisation and reports errors", async () => {
    embedCall.mockResolvedValue({ tolist: () => [[0.5, 0.5], [1, 0]] });
    await handle({ id: 4, type: "embed", model: "Xenova/multilingual-e5-small", device: "wasm", texts: ["a", "b"] });
    expect(embedCall.mock.calls[0][1]).toEqual({ pooling: "mean", normalize: true });
    expect(posted.at(-1)).toEqual({ id: 4, type: "result", value: { vectors: [[0.5, 0.5], [1, 0]], dims: 2 } });
    embedCall.mockRejectedValueOnce(new Error("oom"));
    await handle({ id: 5, type: "embed", model: "Xenova/multilingual-e5-small", device: "wasm", texts: ["c"] });
    expect(posted.at(-1)).toEqual({ id: 5, type: "error", message: "oom" });
    await handle({ id: 6, type: "load", task: "feature-extraction", model: "m2", device: "wasm" });
    expect(posted.at(-1)).toEqual({ id: 6, type: "result", value: "m2" });
    await handle({ id: 7, type: "unload" });
    expect(posted.at(-1)).toEqual({ id: 7, type: "result", value: true });
  });
});
