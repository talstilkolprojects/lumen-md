/**
 * Local model manager — which in-browser (web-llm) model to run on this
 * device, by hardware and by tier.
 *
 * The catalog is a curated subset of web-llm's prebuilt models with their
 * VRAM needs (from the library's own config); `recommendWebLlmModel()`
 * picks the largest model of a tier that fits the detected GPU budget,
 * `q4f16` when the adapter has shader-f16 and `q4f32` otherwise. The
 * user's own choice (`lumen.ai.model.local-webgpu`) wins when it is set.
 *
 * Nothing here loads the library: detection uses `navigator.gpu` only.
 */

import type { ModelTier } from "../agents/types";

export interface WebLlmCatalogEntry {
  /** Model id without the quantisation suffix, e.g. "Qwen3-4B". */
  base: string;
  label: string;
  tier: ModelTier;
  /** Approximate VRAM in MB for q4f16 / q4f32 (web-llm's `vram_required_MB`). */
  vramMB: { f16: number; f32: number };
  /** web-llm marks these as runnable on limited devices. */
  lowResource: boolean;
  /** Supports function calling natively in web-llm. */
  tools?: boolean;
  /** Good at code (preferred by the builder agent). */
  code?: boolean;
  /** Declared multilingual by the model's authors (Hebrew not verified by us). */
  multilingual?: boolean;
  /** Custom-licence model (plan 1.7): listed with its notice, never picked automatically. */
  licence?: string;
}

export const WEBLLM_CATALOG: WebLlmCatalogEntry[] = [
  { base: "SmolLM2-360M-Instruct", label: "SmolLM2 360M", tier: "tiny", vramMB: { f16: 376, f32: 580 }, lowResource: true },
  { base: "Qwen3-0.6B", label: "Qwen3 0.6B", tier: "tiny", vramMB: { f16: 1403, f32: 1925 }, lowResource: true, multilingual: true },
  { base: "Llama-3.2-1B-Instruct", label: "Llama 3.2 1B", tier: "tiny", vramMB: { f16: 879, f32: 1129 }, lowResource: true, multilingual: true, licence: "Llama 3.2 Community License" },
  { base: "SmolLM2-1.7B-Instruct", label: "SmolLM2 1.7B", tier: "tiny", vramMB: { f16: 1774, f32: 2692 }, lowResource: true },
  { base: "Llama-3.2-3B-Instruct", label: "Llama 3.2 3B", tier: "small", vramMB: { f16: 2264, f32: 2952 }, lowResource: true, multilingual: true, licence: "Llama 3.2 Community License" },
  // web-llm's function-calling support (functionCallingModelIds) covers the
  // 8B Hermes models only; the 3B model gets the JSON-ReAct protocol.
  { base: "Hermes-3-Llama-3.2-3B", label: "Hermes 3 (Llama 3.2 3B)", tier: "small", vramMB: { f16: 2264, f32: 2952 }, lowResource: true, licence: "Llama 3.2 Community License" },
  { base: "Qwen3-4B", label: "Qwen3 4B", tier: "small", vramMB: { f16: 3432, f32: 4328 }, lowResource: true, multilingual: true },
  { base: "Phi-3.5-mini-instruct", label: "Phi 3.5 mini", tier: "small", vramMB: { f16: 3672, f32: 5483 }, lowResource: false },
  { base: "Qwen2.5-Coder-7B-Instruct", label: "Qwen2.5 Coder 7B", tier: "medium", vramMB: { f16: 5107, f32: 5900 }, lowResource: false, code: true },
  { base: "Llama-3.1-8B-Instruct", label: "Llama 3.1 8B", tier: "medium", vramMB: { f16: 5001, f32: 6101 }, lowResource: false, multilingual: true, licence: "Llama 3.1 Community License" },
  { base: "Hermes-3-Llama-3.1-8B", label: "Hermes 3 (Llama 3.1 8B)", tier: "medium", vramMB: { f16: 4876, f32: 5779 }, lowResource: false, tools: true, licence: "Llama 3.1 Community License" },
  { base: "Qwen3-8B", label: "Qwen3 8B", tier: "medium", vramMB: { f16: 5696, f32: 6853 }, lowResource: false, multilingual: true },
  { base: "gemma-2-9b-it", label: "Gemma 2 9B", tier: "large", vramMB: { f16: 6422, f32: 8383 }, lowResource: false, multilingual: true, licence: "Gemma Terms of Use" },
];

export const WEBLLM_MODEL_KEY = "lumen.ai.model.local-webgpu";

export interface Hardware {
  webgpu: boolean;
  /** shader-f16 → q4f16 models (half the VRAM). */
  f16: boolean;
  /** Largest single GPU buffer, MB (web-llm needs this for the weights). */
  maxBufferMB: number | null;
  /** `navigator.deviceMemory`, GB (Chromium only, coarse). */
  deviceMemoryGB: number | null;
  cores: number | null;
  mobile: boolean;
  /** Why WebGPU is unusable, when it is. */
  reason?: string;
}

let hardware: Promise<Hardware> | null = null;

function detectMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  if (typeof nav.userAgentData?.mobile === "boolean") return nav.userAgentData.mobile;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent ?? "");
}

/** Probe the GPU once (cached). Safe to call anywhere; never throws. */
export function detectHardware(force = false): Promise<Hardware> {
  if (hardware && !force) return hardware;
  hardware = (async (): Promise<Hardware> => {
    const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { deviceMemory?: number; gpu?: GPU }) : undefined;
    const base: Hardware = {
      webgpu: false,
      f16: false,
      maxBufferMB: null,
      deviceMemoryGB: typeof nav?.deviceMemory === "number" ? nav.deviceMemory : null,
      cores: typeof nav?.hardwareConcurrency === "number" ? nav.hardwareConcurrency : null,
      mobile: detectMobile(),
    };
    if (!nav?.gpu) return { ...base, reason: "no-webgpu" };
    try {
      const adapter = await nav.gpu.requestAdapter();
      if (!adapter) return { ...base, reason: "no-adapter" };
      return {
        ...base,
        webgpu: true,
        f16: adapter.features?.has("shader-f16") ?? false,
        maxBufferMB: typeof adapter.limits?.maxBufferSize === "number" ? Math.floor(adapter.limits.maxBufferSize / (1024 * 1024)) : null,
      };
    } catch (e) {
      return { ...base, reason: "adapter-error: " + ((e as Error)?.message ?? String(e)) };
    }
  })();
  return hardware;
}

/** VRAM we are willing to spend on a model, MB — a heuristic, not a measurement. */
export function vramBudgetMB(hw: Hardware): number {
  if (!hw.webgpu) return 0;
  if (hw.mobile) return 2_000;
  // Integrated / unified memory: a share of system RAM when we know it.
  if (hw.deviceMemoryGB !== null) {
    if (hw.deviceMemoryGB <= 4) return 2_000;
    if (hw.deviceMemoryGB < 8) return 4_000;
    // deviceMemory caps at 8 in browsers, so ≥ 8 means "at least 8".
    return 6_500;
  }
  return 4_500;
}

export function webLlmModelId(entry: WebLlmCatalogEntry, f16: boolean): string {
  return `${entry.base}-${f16 ? "q4f16_1" : "q4f32_1"}-MLC`;
}

export function catalogEntryFor(modelId: string): WebLlmCatalogEntry | undefined {
  return WEBLLM_CATALOG.find((e) => modelId.startsWith(`${e.base}-q4f`));
}

/** The model id for a tier that fits the budget; the largest that fits, else the smallest of the catalog. */
export function recommendWebLlmModel(tier: ModelTier, hw: Hardware, opts: { tools?: boolean; code?: boolean; multilingual?: boolean } = {}): string {
  const budget = vramBudgetMB(hw);
  const vram = (e: WebLlmCatalogEntry) => (hw.f16 ? e.vramMB.f16 : e.vramMB.f32);
  const order: ModelTier[] = ["tiny", "small", "medium", "large"];
  const want = order.indexOf(tier);
  const prefer = (list: WebLlmCatalogEntry[]) => {
    list = list.filter((e) => !e.licence); // custom licences are opt-in only (plan 1.7)
    const scored = list.filter((e) => (!opts.tools || e.tools) && (!opts.code || e.code));
    const base = scored.length ? scored : list;
    // Hebrew notes: a multilingual model of the tier, when one fits (T27).
    const multi = opts.multilingual ? base.filter((e) => e.multilingual) : [];
    return multi.length ? multi : base;
  };
  // Walk from the requested tier down to tiny until something fits.
  for (let i = want; i >= 0; i--) {
    const fits = prefer(WEBLLM_CATALOG.filter((e) => e.tier === order[i] && vram(e) <= budget && (!hw.mobile || e.lowResource)));
    if (fits.length) return webLlmModelId(fits.reduce((b, e) => (vram(e) > vram(b) ? e : b)), hw.f16);
  }
  const smallest = WEBLLM_CATALOG.filter((e) => !e.licence).reduce((b, e) => (vram(e) < vram(b) ? e : b));
  return webLlmModelId(smallest, hw.f16);
}

export function selectedWebLlmModel(): string | null {
  try {
    return localStorage.getItem(WEBLLM_MODEL_KEY);
  } catch {
    return null;
  }
}

export function setWebLlmModel(modelId: string | null): void {
  try {
    if (modelId) localStorage.setItem(WEBLLM_MODEL_KEY, modelId);
    else localStorage.removeItem(WEBLLM_MODEL_KEY);
  } catch {
    /* storage denied */
  }
}

/**
 * The web-llm model to use for a tier: the user's choice when it is set
 * and at least as large as the tier asks for, else the recommendation.
 */
export function webLlmModelFor(tier: ModelTier, hw: Hardware, opts: { tools?: boolean; code?: boolean; multilingual?: boolean } = {}): string {
  const chosen = selectedWebLlmModel();
  if (chosen) {
    const entry = catalogEntryFor(chosen);
    const order: ModelTier[] = ["tiny", "small", "medium", "large"];
    // An explicit choice wins, except that a tool-calling agent gets a
    // function-calling model when the choice has no native tool support
    // and the device can run one (otherwise the choice runs the protocol).
    if (!entry || order.indexOf(entry.tier) >= order.indexOf(tier)) {
      if (!opts.tools || entry?.tools) return chosen;
      const native = recommendWebLlmModel(tier, hw, { tools: true });
      return catalogEntryFor(native)?.tools ? native : chosen;
    }
  }
  return recommendWebLlmModel(tier, hw, opts);
}

/** Tests. */
export function __resetHardware(): void {
  hardware = null;
}
