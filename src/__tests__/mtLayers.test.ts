/**
 * Local translation, the routing side (plan 6.4): which layer runs, consent
 * before any download, the "unavailable until 15.9" path, and each layer's
 * contract against a fake API / worker.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { rankLayers, measuredChrF, type MtLayer, type Pair } from "../ai/mt/layers";
import quality from "../ai/mt/quality.json";
import { translateLocally } from "../ai/mt";
import { chromeTranslatorApi, createChromeLayer, __resetChromeTranslator } from "../ai/mt/chromeTranslator";
import { createM2m100Layer, createOpusLayer, M2M100_LANGUAGES, OPUS_MODELS } from "../ai/mt/localModels";
import type { RegistryModel } from "../ai/convertedModels";

const HE_EN: Pair = { source: "he", target: "en" };
const EN_HE: Pair = { source: "en", target: "he" };
const t = (k: string, v?: Record<string, string | number>) => `${k}${v ? JSON.stringify(v) : ""}`;

describe("layer selection by measured quality", () => {
  const q = (chrF: Record<string, Record<string, number | null>>) => ({ baseline: "opus" as const, chrF: chrF as never });

  it("keeps the plan's order while nothing is measured, and flags every layer unmeasured", () => {
    expect(rankLayers(HE_EN, ["chrome", "opus", "m2m100"], q({ chrome: {}, opus: {}, m2m100: {}, llm: {} }))).toEqual([
      { layer: "chrome", unmeasured: true },
      { layer: "opus", unmeasured: true },
      { layer: "m2m100", unmeasured: true },
    ]);
  });

  it("never auto-selects a layer measured below the Opus-MT baseline", () => {
    const measured = q({ chrome: { "he-en": 40 }, opus: { "he-en": 52 }, m2m100: { "he-en": 55 }, llm: {} });
    expect(rankLayers(HE_EN, ["chrome", "opus", "m2m100"], measured)).toEqual([
      { layer: "m2m100", unmeasured: false },
      { layer: "opus", unmeasured: false },
    ]);
  });

  it("puts measured layers before unmeasured ones", () => {
    const partial = q({ chrome: {}, opus: { "he-en": 52 }, m2m100: {}, llm: {} });
    expect(rankLayers(HE_EN, ["chrome", "opus", "m2m100"], partial).map((c) => c.layer)).toEqual(["opus", "chrome", "m2m100"]);
  });

  it("ships with no numbers: every measurement is open until the harness runs", () => {
    for (const layer of ["chrome", "opus", "m2m100", "llm"] as const) for (const pair of [HE_EN, EN_HE]) expect(measuredChrF(layer, pair)).toBeNull();
    expect(quality.baseline).toBe("opus");
  });
});

function fakeLayer(id: MtLayer["id"], o: { supports?: boolean; state?: "ready" | "downloadable" | "unavailable"; accept?: boolean; reason?: string }): MtLayer & { prepare: ReturnType<typeof vi.fn>; translate: ReturnType<typeof vi.fn> } {
  return {
    id,
    supports: () => o.supports ?? true,
    availability: async () => (o.state === "unavailable" ? { state: "unavailable", reason: o.reason ?? `mt.layer.${id}.noHost` } : o.state === "downloadable" ? { state: "downloadable", bytes: 100 } : { state: "ready" }),
    prepare: vi.fn(async () => o.accept ?? true),
    translate: vi.fn(async (texts: string[]) => texts.map((s) => `[${id}] ${s}`)),
  };
}
const consent = { confirm: async () => true, t };

describe("translateLocally", () => {
  it("uses the first layer that can run and keeps the document's structure", async () => {
    const chrome = fakeLayer("chrome", { state: "unavailable", reason: "mt.layer.chrome.absent" });
    const opus = fakeLayer("opus", { state: "ready" });
    const r = await translateLocally("# Title\n\nHello `x` world.", HE_EN, consent, { layers: [chrome, opus] });
    expect(r.layer).toBe("opus");
    if (r.layer) {
      expect(r.text).toBe("# [opus] Title\n\n[opus] Hello `x` world.");
      expect(r.unmeasured).toBe(true);
    }
    expect(opus.prepare).toHaveBeenCalledTimes(1);
  });

  it("reports why every layer was unavailable: the 15.9 path", async () => {
    const chrome = fakeLayer("chrome", { state: "unavailable", reason: "mt.layer.chrome.absent" });
    const opus = fakeLayer("opus", { state: "unavailable", reason: "mt.layer.opus.noHost" });
    const m2m = fakeLayer("m2m100", { supports: false });
    const r = await translateLocally("text", EN_HE, consent, { layers: [chrome, opus, m2m] });
    expect(r).toEqual({ layer: null, reasons: { chrome: "mt.layer.chrome.absent", opus: "mt.layer.opus.noHost", m2m100: "mt.layer.m2m100.pair" } });
  });

  it("a declined download stops further download prompts, but a ready layer still runs", async () => {
    const chrome = fakeLayer("chrome", { state: "downloadable", accept: false });
    const opus = fakeLayer("opus", { state: "downloadable" });
    const m2m = fakeLayer("m2m100", { state: "ready" });
    const r = await translateLocally("text", HE_EN, consent, { layers: [chrome, opus, m2m] });
    expect(r.layer).toBe("m2m100");
    expect(opus.prepare).not.toHaveBeenCalled();
    const none = await translateLocally("text", HE_EN, consent, { layers: [chrome, opus] });
    expect(none).toEqual({ layer: null, reasons: { chrome: "declined", opus: "declined" } });
  });

  it("routes paragraph by paragraph: one already in the target language is left as it is (plan 6.5)", async () => {
    const opus = fakeLayer("opus", { state: "ready" });
    const r = await translateLocally("שורה בעברית.\n\nAn English line.", HE_EN, consent, {
      layers: [opus],
      detect: (p) => (/[֐-׿]/.test(p) ? { lang: "he", confident: true } : { lang: "en", confident: true }),
    });
    expect(r.layer && r.text).toBe("[opus] שורה בעברית.\n\nAn English line.");
  });
});

describe("layer 1: Chrome's built-in Translator", () => {
  beforeEach(() => __resetChromeTranslator());

  function fakeApi(avail: string) {
    const translate = vi.fn(async (s: string) => `«${s}»`);
    const create = vi.fn(async (o: { monitor?: (m: EventTarget) => void }) => {
      const m = new EventTarget();
      o.monitor?.(m);
      m.dispatchEvent(Object.assign(new Event("downloadprogress"), { loaded: 0.5 }));
      return { translate };
    });
    return { api: { availability: vi.fn(async () => avail), create }, translate, create };
  }

  it("is absent outside Chrome and reports it", async () => {
    expect(chromeTranslatorApi({})).toBeNull();
    const layer = createChromeLayer(() => null);
    expect(layer.supports(HE_EN)).toBe(false);
    expect(await layer.availability(HE_EN)).toEqual({ state: "unavailable", reason: "mt.layer.chrome.absent" });
  });

  it("maps the API's states, creates one translator per pair and reports download progress", async () => {
    const { api, translate, create } = fakeApi("downloadable");
    const layer = createChromeLayer(() => api as never);
    expect(await layer.availability(HE_EN)).toEqual({ state: "downloadable" });
    const progress: number[] = [];
    expect(await layer.prepare(HE_EN, { onProgress: (p) => progress.push(p.progress) })).toBe(true);
    expect(progress).toEqual([50]);
    expect(await layer.translate(["a", "b"], HE_EN, {})).toEqual(["«a»", "«b»"]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ sourceLanguage: "he", targetLanguage: "en" });
    expect(translate).toHaveBeenCalledTimes(2);
    (api.availability as ReturnType<typeof vi.fn>).mockResolvedValueOnce("unavailable");
    expect(await layer.availability({ source: "he", target: "xx" })).toEqual({ state: "unavailable", reason: "mt.layer.chrome.pair" });
  });
});

describe("layer 2: Opus-MT, the converted models", () => {
  const entry = (files: boolean): RegistryModel => ({
    id: "opus-mt-tc-big-he-en",
    license: "CC-BY-4.0",
    attribution: "OPUS-MT © Helsinki-NLP",
    files: files ? [{ path: "config.json", sha256: "0".repeat(64), bytes: 1000, dtype: "config", license: "CC-BY-4.0", attribution: "x" }, { path: "onnx/encoder_model_quantized.onnx", sha256: "1".repeat(64), bytes: 300_000_000, dtype: "q8", license: "CC-BY-4.0", attribution: "x" }] : undefined,
  });
  const env = (o: { base?: string | null; files?: boolean; cached?: boolean }) => {
    const translate = vi.fn(async (_m: string, texts: string[]) => texts.map((s) => `${s}!`));
    const confirm = vi.fn(async (_o: { title: string; message: string; okLabel: string }) => true);
    const root = { getDirectoryHandle: async () => { throw new DOMException("x", "NotFoundError"); } } as unknown as FileSystemDirectoryHandle;
    return {
      translate,
      confirm,
      env: {
        base: () => o.base ?? null,
        registry: async () => new Map([["opus-mt-tc-big-he-en", entry(o.files ?? true)]]),
        opfsRoot: async () => root,
        device: async () => "wasm" as const,
        translate,
        consent: { confirm, t, locale: "en" },
      },
    };
  };

  it("knows exactly the two converted pairs", () => {
    expect(OPUS_MODELS).toEqual({ "en-he": "opus-mt-en-he", "he-en": "opus-mt-tc-big-he-en" });
    const layer = createOpusLayer(consent, env({}).env);
    expect(layer.supports(HE_EN)).toBe(true);
    expect(layer.supports({ source: "fr", target: "he" })).toBe(false);
  });

  it("is unavailable, with the reason, while there is no host (15.9) or no checksums", async () => {
    const noHost = createOpusLayer(consent, env({ base: null }).env);
    expect(await noHost.availability(HE_EN)).toEqual({ state: "unavailable", reason: "mt.layer.opus.noHost" });
    expect(await noHost.prepare(HE_EN, {})).toBe(false);
    const noFiles = createOpusLayer(consent, env({ base: "https://h/", files: false }).env);
    expect(await noFiles.availability(HE_EN)).toEqual({ state: "unavailable", reason: "mt.layer.opus.noFiles" });
  });

  it("asks before downloading, with the size, licence and attribution, and translates through the worker with the host", async () => {
    const e = env({ base: "https://models.example/" });
    const layer = createOpusLayer(consent, e.env);
    expect(await layer.availability(HE_EN)).toEqual({ state: "downloadable", bytes: 300_001_000 });
    expect(await layer.prepare(HE_EN, {})).toBe(true);
    const asked = e.confirm.mock.calls[0][0];
    expect(asked.message).toContain('"size":"300 MB"');
    expect(asked.message).toContain('"license":"CC-BY-4.0"');
    expect(asked.message).toContain("Helsinki-NLP");
    expect(asked.okLabel).toContain("300 MB");
    expect(await layer.translate(["שלום"], HE_EN, {})).toEqual(["שלום!"]);
    expect(e.translate).toHaveBeenCalledWith("opus-mt-tc-big-he-en", ["שלום"], expect.objectContaining({ host: "https://models.example/", dtype: "q8" }));
    e.confirm.mockResolvedValueOnce(false);
    expect(await layer.prepare(HE_EN, {})).toBe(false);
  });
});

describe("layer 3: M2M100 for the other pairs", () => {
  it("covers M2M100's languages, asks once with size and licence, and remembers a loaded model", async () => {
    const store = new Map<string, string>();
    const translate = vi.fn(async (_m: string, texts: string[]) => texts);
    const confirm = vi.fn(async (_o: { title: string; message: string; okLabel: string }) => true);
    const layer = createM2m100Layer(consent, {
      base: () => null,
      registry: async () => new Map(),
      opfsRoot: async () => ({}) as FileSystemDirectoryHandle,
      device: async () => "wasm",
      translate,
      consent: { confirm, t },
      storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
    });
    expect(M2M100_LANGUAGES.has("he") && M2M100_LANGUAGES.has("fr")).toBe(true);
    expect(layer.supports({ source: "fr", target: "he" })).toBe(true);
    expect(layer.supports({ source: "fr", target: "fr" })).toBe(false);
    expect(layer.supports({ source: "fr", target: "tlh" })).toBe(false);
    expect(await layer.availability({ source: "fr", target: "he" })).toMatchObject({ state: "downloadable" });
    expect(await layer.prepare({ source: "fr", target: "he" }, {})).toBe(true);
    const asked = confirm.mock.calls[0][0];
    expect(asked.message).toContain('"license":"MIT"');
    expect(asked.message).toContain("630 MB");
    await layer.translate(["bonjour"], { source: "fr", target: "he" }, {});
    expect(translate).toHaveBeenCalledWith("Xenova/m2m100_418M", ["bonjour"], expect.objectContaining({ srcLang: "fr", tgtLang: "he" }));
    expect(await layer.availability({ source: "fr", target: "he" })).toEqual({ state: "ready" });
    await layer.prepare({ source: "fr", target: "he" }, {});
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
