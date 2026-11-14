/**
 * The transformers.js worker's translation job (plan 6.4): the pipeline it
 * builds, batching and progress, and how a model Lumen hosts itself is
 * loaded — from `${host}${model}/` into the verified OPFS cache, with the
 * library's global host put back afterwards.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { pipelineFn, translateCall, env, seen, createModelCache } = vi.hoisted(() => {
  const translateCall = vi.fn(async (texts: string[], kwargs: Record<string, unknown>) => texts.map((s) => ({ translation_text: `${s}→${kwargs.tgt_lang ?? "x"}` })));
  const seen: Array<{ remoteHost: string; remotePathTemplate: string; useCustomCache?: boolean }> = [];
  const env = {
    allowLocalModels: true,
    useBrowserCache: false,
    useWasmCache: false,
    remoteHost: "https://huggingface.co/",
    remotePathTemplate: "{model}/resolve/{revision}/",
    customCache: undefined as unknown,
    useCustomCache: false,
    backends: { onnx: { wasm: { wasmPaths: undefined as unknown } } },
  };
  const pipelineFn = vi.fn(async (_task: string, _model: string, opts: { progress_callback?: (i: unknown) => void }) => {
    // What the library would read while downloading the model's files.
    seen.push({ remoteHost: env.remoteHost, remotePathTemplate: env.remotePathTemplate, useCustomCache: env.useCustomCache });
    opts.progress_callback?.({ status: "progress", file: "onnx/encoder_model_quantized.onnx", progress: 10, loaded: 1, total: 10 });
    const pipe = (input: string[], kwargs: Record<string, unknown>) => translateCall(input, kwargs);
    (pipe as unknown as { dispose: () => Promise<void> }).dispose = async () => {};
    return pipe;
  });
  const createModelCache = vi.fn(() => ({ match: async () => undefined, put: async () => undefined }));
  return { pipelineFn, translateCall, env, seen, createModelCache };
});
vi.mock("@huggingface/transformers", () => ({ env, pipeline: pipelineFn, AutoTokenizer: {}, AutoModelForSequenceClassification: {} }));
vi.mock("../ai/modelCache", () => ({ createModelCache }));
vi.mock("../ai/convertedModels", () => ({ loadConvertedRegistry: async () => new Map() }));
vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({}) } });
vi.stubGlobal("caches", { open: async () => ({}) });

const posted: Array<Record<string, unknown>> = [];
vi.stubGlobal("postMessage", (m: Record<string, unknown>) => posted.push(m));

import { handle } from "../ai/transformers.worker";

describe("worker: translate", () => {
  beforeEach(() => {
    posted.length = 0;
    pipelineFn.mockClear();
    translateCall.mockClear();
    seen.length = 0;
  });

  it("loads a translation pipeline in the device's dtype, translates in batches of 4 and reports progress", async () => {
    const texts = Array.from({ length: 6 }, (_, i) => `t${i}`);
    await handle({ id: 1, type: "translate", model: "Xenova/m2m100_418M", device: "wasm", texts, srcLang: "fr", tgtLang: "he" });
    expect(pipelineFn.mock.calls[0][0]).toBe("translation");
    expect(pipelineFn.mock.calls[0][1]).toBe("Xenova/m2m100_418M");
    expect(pipelineFn.mock.calls[0][2]).toMatchObject({ device: "wasm", dtype: "q8" });
    expect(translateCall).toHaveBeenCalledTimes(2);
    expect(translateCall.mock.calls[0][0]).toEqual(["t0", "t1", "t2", "t3"]);
    expect(translateCall.mock.calls[0][1]).toMatchObject({ src_lang: "fr", tgt_lang: "he" });
    const result = posted.find((m) => m.type === "result");
    expect(result?.value).toEqual(texts.map((s) => `${s}→he`));
    const progress = posted.filter((m) => m.type === "progress").map((m) => m.progress);
    expect(progress).toEqual([10, 67, 100]);
    // No host: the library's own host was untouched and no custom cache was installed.
    expect(seen[0]).toMatchObject({ remoteHost: "https://huggingface.co/", useCustomCache: false });
  });

  it("loads a self-hosted model from the host with the verified OPFS cache, then puts the library's host back", async () => {
    await handle({ id: 2, type: "translate", model: "opus-mt-tc-big-he-en", device: "webgpu", texts: ["שלום"], host: "https://models.example/" });
    expect(pipelineFn.mock.calls[0][2]).toMatchObject({ device: "webgpu", dtype: "q4f16" });
    expect(seen[0]).toEqual({ remoteHost: "https://models.example/", remotePathTemplate: "{model}/", useCustomCache: true });
    expect(createModelCache).toHaveBeenCalledWith(expect.objectContaining({ base: "https://models.example/" }));
    // After the load: back to Hugging Face for every other model.
    expect(env.remoteHost).toBe("https://huggingface.co/");
    expect(env.remotePathTemplate).toBe("{model}/resolve/{revision}/");
    expect(posted.find((m) => m.type === "result")?.value).toEqual(["שלום→x"]);
    // The same model again: no second pipeline.
    await handle({ id: 3, type: "translate", model: "opus-mt-tc-big-he-en", device: "webgpu", texts: ["a"], host: "https://models.example/" });
    expect(pipelineFn).toHaveBeenCalledTimes(1);
  });

  it("a failed load is reported, not thrown, and the host is still restored", async () => {
    pipelineFn.mockRejectedValueOnce(new Error("404 config.json"));
    await handle({ id: 4, type: "translate", model: "opus-mt-en-he", device: "wasm", texts: ["x"], host: "https://models.example/" });
    expect(posted).toEqual([{ id: 4, type: "error", message: "404 config.json" }]);
    expect(env.remoteHost).toBe("https://huggingface.co/");
  });
});
