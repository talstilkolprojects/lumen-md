import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  WEBLLM_CATALOG,
  catalogEntryFor,
  detectHardware,
  recommendWebLlmModel,
  selectedWebLlmModel,
  setWebLlmModel,
  vramBudgetMB,
  webLlmModelFor,
  webLlmModelId,
  __resetHardware,
  type Hardware,
} from "../ai/modelManager";
import { tierForMode } from "../ai/aiMode";
import { webGpuGap } from "../ai/webGpuGap";

const hw = (over: Partial<Hardware> = {}): Hardware => ({ webgpu: true, f16: true, maxBufferMB: 2048, deviceMemoryGB: 8, cores: 8, mobile: false, ...over });

function stubNavigator(nav: Record<string, unknown>) {
  Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true });
}

describe("model manager — catalog and recommendation", () => {
  it("names models by quantisation and finds catalog entries", () => {
    const e = WEBLLM_CATALOG.find((x) => x.base === "Qwen3-4B")!;
    expect(webLlmModelId(e, true)).toBe("Qwen3-4B-q4f16_1-MLC");
    expect(webLlmModelId(e, false)).toBe("Qwen3-4B-q4f32_1-MLC");
    expect(catalogEntryFor("Qwen3-4B-q4f32_1-MLC")?.label).toBe("Qwen3 4B");
    expect(catalogEntryFor("Nope-q4f16_1-MLC")).toBeUndefined();
  });

  it("budgets VRAM by device class", () => {
    expect(vramBudgetMB(hw({ webgpu: false }))).toBe(0);
    expect(vramBudgetMB(hw({ mobile: true }))).toBe(2000);
    expect(vramBudgetMB(hw({ deviceMemoryGB: 4 }))).toBe(2000);
    expect(vramBudgetMB(hw({ deviceMemoryGB: 8 }))).toBe(6500);
    expect(vramBudgetMB(hw({ deviceMemoryGB: null }))).toBe(4500);
  });

  it("recommends the largest model of the tier that fits, walking down when nothing fits", () => {
    expect(recommendWebLlmModel("small", hw())).toBe("Phi-3.5-mini-instruct-q4f16_1-MLC");
    expect(recommendWebLlmModel("medium", hw())).toBe("Qwen3-8B-q4f16_1-MLC");
    // 4 GB device, f32 weights: nothing above tiny fits a 2 GB budget → the largest tiny model.
    expect(recommendWebLlmModel("large", hw({ f16: false, deviceMemoryGB: 4 }))).toBe("Qwen3-0.6B-q4f32_1-MLC");
    expect(recommendWebLlmModel("tiny", hw())).toBe("SmolLM2-1.7B-Instruct-q4f16_1-MLC");
    // Mobile: low-resource models only.
    expect(recommendWebLlmModel("medium", hw({ mobile: true }))).toBe("SmolLM2-1.7B-Instruct-q4f16_1-MLC");
    // Nothing fits at all (no budget) → the smallest in the catalog.
    expect(recommendWebLlmModel("tiny", hw({ webgpu: false }))).toBe("SmolLM2-360M-Instruct-q4f16_1-MLC");
  });

  it("never picks a custom-licence model automatically, but lists it with its licence", () => {
    for (const tier of ["tiny", "small", "medium", "large"] as const) {
      for (const opts of [{}, { tools: true }, { multilingual: true }]) {
        expect(recommendWebLlmModel(tier, hw(), opts)).not.toMatch(/Llama|Hermes|gemma/);
      }
    }
  });

  it("prefers tool-calling and code models when asked", () => {
    // Hermes (Llama licence) is no longer picked automatically (plan 1.7): an open-licence model gets JSON-ReAct.
    expect(recommendWebLlmModel("medium", hw(), { tools: true })).toBe("Qwen3-8B-q4f16_1-MLC");
    expect(recommendWebLlmModel("medium", hw(), { code: true })).toBe("Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC");
    // No tool model in the tier → the plain recommendation.
    expect(recommendWebLlmModel("tiny", hw(), { tools: true })).toBe("SmolLM2-1.7B-Instruct-q4f16_1-MLC");
  });
});

describe("model manager — selection and hardware", () => {
  beforeEach(() => {
    setWebLlmModel(null);
    __resetHardware();
  });
  afterEach(() => {
    setWebLlmModel(null);
    __resetHardware();
  });

  it("keeps the user's model when it is at least the tier's size, else recommends", () => {
    expect(selectedWebLlmModel()).toBeNull();
    setWebLlmModel("Qwen3-4B-q4f16_1-MLC");
    expect(webLlmModelFor("small", hw())).toBe("Qwen3-4B-q4f16_1-MLC");
    expect(webLlmModelFor("tiny", hw())).toBe("Qwen3-4B-q4f16_1-MLC");
    expect(webLlmModelFor("medium", hw())).toBe("Qwen3-8B-q4f16_1-MLC");
    // A tool-calling agent no longer swaps to Hermes (Llama licence, plan 1.7); the open-licence choice stays…
    setWebLlmModel("Qwen3-8B-q4f16_1-MLC");
    expect(webLlmModelFor("medium", hw(), { tools: true })).toBe("Qwen3-8B-q4f16_1-MLC");
    expect(webLlmModelFor("medium", hw())).toBe("Qwen3-8B-q4f16_1-MLC");
    // …and keeps the choice when no native tool model fits (mobile budget).
    expect(webLlmModelFor("medium", hw({ mobile: true }), { tools: true })).toBe("Qwen3-8B-q4f16_1-MLC");
    // An id outside the catalog is trusted as-is.
    setWebLlmModel("Custom-Model-q4f16_1-MLC");
    expect(webLlmModelFor("large", hw())).toBe("Custom-Model-q4f16_1-MLC");
  });

  it("detects WebGPU, f16 and buffer limits from the adapter", async () => {
    stubNavigator({
      hardwareConcurrency: 12,
      deviceMemory: 8,
      userAgent: "Mozilla/5.0 (Macintosh)",
      gpu: { requestAdapter: async () => ({ features: new Set(["shader-f16"]), limits: { maxBufferSize: 4 * 1024 * 1024 * 1024 } }) },
    });
    const h = await detectHardware();
    expect(h).toMatchObject({ webgpu: true, f16: true, maxBufferMB: 4096, deviceMemoryGB: 8, cores: 12, mobile: false });
    // Cached.
    expect(await detectHardware()).toBe(h);
  });

  it("reports missing WebGPU, a null adapter, and mobile user agents", async () => {
    stubNavigator({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" });
    expect(await detectHardware()).toMatchObject({ webgpu: false, reason: "no-webgpu", mobile: true });
    __resetHardware();
    stubNavigator({ userAgent: "x", gpu: { requestAdapter: async () => null } });
    expect(await detectHardware()).toMatchObject({ webgpu: false, reason: "no-adapter" });
    __resetHardware();
    stubNavigator({
      userAgent: "x",
      gpu: {
        requestAdapter: async () => {
          throw new Error("boom");
        },
      },
    });
    expect((await detectHardware()).reason).toMatch(/adapter-error: boom/);
  });
});

describe("model manager — AI modes and WebGPU gaps (plan 5.7)", () => {
  it("economy runs one tier down, quality one tier up, balanced as declared; the ends hold", () => {
    expect(tierForMode("small", "economy")).toBe("tiny");
    expect(tierForMode("small", "balanced")).toBe("small");
    expect(tierForMode("small", "quality")).toBe("medium");
    expect(tierForMode("tiny", "economy")).toBe("tiny");
    expect(tierForMode("large", "quality")).toBe("large");
  });

  it("the mode's tier picks a different in-browser model, within the device budget", () => {
    const big = hw({ deviceMemoryGB: 8 });
    const economy = webLlmModelFor(tierForMode("small", "economy"), big);
    const balanced = webLlmModelFor(tierForMode("small", "balanced"), big);
    const quality = webLlmModelFor(tierForMode("small", "quality"), big);
    expect(catalogEntryFor(economy)?.tier).toBe("tiny");
    expect(catalogEntryFor(balanced)?.tier).toBe("small");
    expect(catalogEntryFor(quality)?.tier).toBe("medium");
    // A 4 GB device: quality still gets what fits, never more than the budget.
    const small = hw({ deviceMemoryGB: 4 });
    const q = catalogEntryFor(webLlmModelFor(tierForMode("small", "quality"), small))!;
    expect(q.vramMB.f16).toBeLessThanOrEqual(vramBudgetMB(small));
  });

  it("names Firefox on Linux and Android as known WebGPU gaps", () => {
    const off = { webgpu: false };
    expect(webGpuGap(off, "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe("firefox-linux");
    expect(webGpuGap(off, "Mozilla/5.0 (Android 14; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0")).toBe("android");
    expect(webGpuGap(off, "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36")).toBe("android");
    expect(webGpuGap(off, "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0")).toBeNull();
    expect(webGpuGap({ webgpu: true }, "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")).toBeNull();
  });
});
