/**
 * The transformers.js worker's caption job (plan 6.6): Florence-2 with its
 * `<CAPTION>` task prompt, SmolVLM through its chat template (only the new
 * tokens decoded), per-part dtypes on WebGPU, q8 on wasm.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { florence, vlm, processorFor, generate, env } = vi.hoisted(() => {
  const generate = vi.fn(async (_o: unknown) => ({ slice: (...a: unknown[]) => ({ sliced: a }) }));
  const model = { generate, dispose: vi.fn(async () => {}) };
  const florence = { from_pretrained: vi.fn(async (_id: string, _o: unknown) => model) };
  const vlm = { from_pretrained: vi.fn(async (_id: string, _o: unknown) => model) };
  const processorFor = vi.fn((id: string) => {
    const p = Object.assign(vi.fn(async (..._a: unknown[]) => ({ input_ids: { dims: [1, 7] }, pixel_values: "px" })), {
      construct_prompts: vi.fn(() => ["What does the image describe?"]),
      post_process_generation: vi.fn((_t: string, task: string) => ({ [task]: "A cat sitting on a sofa." })),
      apply_chat_template: vi.fn(() => "<prompt>"),
      batch_decode: vi.fn(() => [id.includes("Florence") ? "</s><s>A cat sitting on a sofa.</s>" : "A dog on a beach."]),
    });
    return p;
  });
  const env = { allowLocalModels: true, useBrowserCache: false, useWasmCache: false, backends: { onnx: { wasm: {} } } };
  return { florence, vlm, processorFor, generate, env };
});
vi.mock("@huggingface/transformers", () => ({
  env,
  pipeline: vi.fn(),
  AutoTokenizer: {},
  AutoModelForSequenceClassification: {},
  Florence2ForConditionalGeneration: florence,
  AutoModelForVision2Seq: vlm,
  AutoProcessor: { from_pretrained: vi.fn(async (id: string) => processorFor(id)) },
  RawImage: { fromBlob: vi.fn(async () => ({ size: [640, 480] })) },
}));
const posted: Array<Record<string, unknown>> = [];
vi.stubGlobal("postMessage", (m: Record<string, unknown>) => posted.push(m));

import { handle } from "../ai/transformers.worker";

const result = (id: number) => posted.find((m) => m.id === id && m.type !== "progress");

describe("worker: caption", () => {
  beforeEach(() => {
    posted.length = 0;
    generate.mockClear();
    florence.from_pretrained.mockClear();
    vlm.from_pretrained.mockClear();
  });

  it("Florence-2: <CAPTION> task, post-processed text, per-part dtypes on WebGPU", async () => {
    await handle({ id: 1, type: "caption", model: "onnx-community/Florence-2-base-ft", family: "florence2", device: "webgpu", image: new Blob(["x"]) });
    expect(result(1)).toEqual({ id: 1, type: "result", value: "A cat sitting on a sofa." });
    expect(florence.from_pretrained.mock.calls[0][1]).toMatchObject({ device: "webgpu", dtype: { vision_encoder: "fp16", decoder_model_merged: "q4" } });
    expect(generate.mock.calls[0][0]).toMatchObject({ pixel_values: "px", max_new_tokens: 64, do_sample: false });
  });

  it("SmolVLM: chat template, only the generated tokens decoded, q8 on wasm; the model is reloaded on a family change", async () => {
    await handle({ id: 2, type: "caption", model: "HuggingFaceTB/SmolVLM-256M-Instruct", family: "smolvlm", device: "wasm", image: new Blob(["x"]) });
    expect(result(2)).toEqual({ id: 2, type: "result", value: "A dog on a beach." });
    expect(vlm.from_pretrained.mock.calls[0][1]).toMatchObject({ device: "wasm", dtype: "q8" });
  });

  it("a cancelled job reports AbortError", async () => {
    const p = handle({ id: 3, type: "caption", model: "HuggingFaceTB/SmolVLM-256M-Instruct", family: "smolvlm", device: "wasm", image: new Blob(["x"]) });
    await handle({ id: 4, type: "cancel", target: 3 });
    await p;
    expect(result(3)).toMatchObject({ type: "error" });
  });
});
