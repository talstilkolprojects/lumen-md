/**
 * Self-converted models (plan 6.0): the consent gate, sizes, and the
 * verified OPFS cache transformers.js would use for them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { installFakeOpfs, type FakeDir } from "./helpers/fakeOpfs";
import {
  CONVERTED_MODELS,
  CONVERTED_MODELS_BASE,
  downloadBytes,
  fileUrl,
  formatSize,
  loadConvertedRegistry,
  requestConvertedModel,
  type RegistryModel,
} from "../ai/convertedModels";
import { createModelCache, isModelCached, parseModelUrl, removeCachedModel, sha256Hex, type CacheLike } from "../ai/modelCache";

const BASE = "https://models.example/lumen/";
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

async function entryWith(contents: Record<string, { text: string; dtype: string }>): Promise<RegistryModel> {
  const files = [];
  for (const [path, { text, dtype }] of Object.entries(contents)) {
    files.push({ path, sha256: await sha256Hex(enc(text)), bytes: enc(text).byteLength, dtype, license: "Apache-2.0", attribution: "© Test" });
  }
  return { id: "opus-mt-en-he", license: "Apache-2.0", attribution: "© Test", files };
}

describe("converted models catalog", () => {
  it("lists the four plan-6.0 models and Nakdimon (6.3), each in the registry with licence and attribution", async () => {
    expect(CONVERTED_MODELS.map((m) => m.id)).toEqual([
      "opus-mt-en-he",
      "opus-mt-tc-big-he-en",
      "dictabert-ner",
      "siglip-base-patch16-256-multilingual",
      "nakdimon",
    ]);
    const reg = await loadConvertedRegistry();
    for (const m of CONVERTED_MODELS) {
      const e = reg.get(m.id);
      expect(e, m.id).toBeTruthy();
      expect(e!.license).toMatch(/^(Apache-2\.0|CC-BY-4\.0|MIT)$/);
      expect(e!.attribution.length).toBeGreaterThan(20);
      // Every published file carries the checksum, size, licence and attribution.
      for (const f of e!.files ?? []) {
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(f.bytes).toBeGreaterThan(0);
        expect(f.license).toBe(e!.license);
        expect(f.attribution).toBe(e!.attribution);
      }
    }
  });

  it("has no host until 15.9, so nothing can be downloaded", () => {
    expect(CONVERTED_MODELS_BASE).toBeNull();
    expect(fileUrl("opus-mt-en-he", "config.json")).toBeNull();
    expect(fileUrl("opus-mt-en-he", "onnx/x.onnx", "https://h/m")).toBe("https://h/m/opus-mt-en-he/onnx/x.onnx");
  });

  it("sizes a dtype as its ONNX files plus every config file", async () => {
    const e = await entryWith({ "config.json": { text: "{}", dtype: "config" }, "onnx/a_quantized.onnx": { text: "q8q8q8", dtype: "q8" }, "onnx/a_q4f16.onnx": { text: "q4", dtype: "q4f16" } });
    expect(downloadBytes(e, "q8")).toBe(2 + 6);
    expect(downloadBytes(e, "q4f16")).toBe(2 + 2);
    expect(formatSize(612_400_000, "en")).toBe("612 MB");
    expect(formatSize(48_340_000, "en")).toBe("48.3 MB");
  });
});

describe("consent before any download", () => {
  const t = (k: string, v?: Record<string, string | number>) => `${k}${v ? JSON.stringify(v) : ""}`;

  it("asks with the size, purpose, licence and attribution, and respects a no", async () => {
    const e = await entryWith({ "config.json": { text: "{}", dtype: "config" }, "onnx/m_quantized.onnx": { text: "x".repeat(10), dtype: "q8" } });
    const confirm = vi.fn(async (_o: { title: string; message: string; okLabel: string }) => false);
    const r = await requestConvertedModel("opus-mt-en-he", "q8", { confirm, isCached: async () => false, t, locale: "en", registry: new Map([[e.id, e]]), base: BASE });
    expect(r).toBe("declined");
    const asked = confirm.mock.calls[0][0];
    expect(asked.message).toContain('"size":"0 MB"');
    expect(asked.message).toContain("models.purpose.translateEnHe");
    expect(asked.message).toContain('"license":"Apache-2.0"');
    expect(asked.message).toContain('"attribution":"© Test"');
    expect(asked.okLabel).toContain("size");
  });

  it("does not ask again for a model already downloaded and verified", async () => {
    const e = await entryWith({ "config.json": { text: "{}", dtype: "config" }, "onnx/m_quantized.onnx": { text: "x", dtype: "q8" } });
    const confirm = vi.fn(async () => true);
    const r = await requestConvertedModel("opus-mt-en-he", "q8", { confirm, isCached: async () => true, t, registry: new Map([[e.id, e]]), base: BASE });
    expect(r).toBe("ready");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("is unavailable without a host or without checksums, and never asks then", async () => {
    const confirm = vi.fn(async () => true);
    const e = await entryWith({ "config.json": { text: "{}", dtype: "config" }, "onnx/m_quantized.onnx": { text: "x", dtype: "q8" } });
    expect(await requestConvertedModel("opus-mt-en-he", "q8", { confirm, isCached: async () => false, t, registry: new Map([[e.id, e]]), base: null })).toBe("unavailable");
    // A dtype that was not built (q4f16 here) is unavailable too.
    expect(await requestConvertedModel("opus-mt-en-he", "q4f16", { confirm, isCached: async () => false, t, registry: new Map([[e.id, e]]), base: BASE })).toBe("unavailable");
    expect(await requestConvertedModel("opus-mt-en-he", "q8", { confirm, isCached: async () => false, t, registry: new Map([[e.id, { ...e, files: undefined }]]), base: BASE })).toBe("unavailable");
    expect(await requestConvertedModel("nope", "q8", { confirm, isCached: async () => false, t, registry: new Map(), base: BASE })).toBe("unavailable");
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("the verified OPFS model cache", () => {
  let root: FakeDir;
  let fallback: CacheLike & { put: ReturnType<typeof vi.fn>; match: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    root = installFakeOpfs();
    fallback = { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined) };
  });

  it("maps only our host's URLs to a model and a path, never outside it", () => {
    expect(parseModelUrl(`${BASE}opus-mt-en-he/onnx/encoder_model_quantized.onnx`, BASE)).toEqual({ id: "opus-mt-en-he", path: "onnx/encoder_model_quantized.onnx" });
    expect(parseModelUrl(`${BASE}opus-mt-en-he/config.json?download=1`, BASE)).toEqual({ id: "opus-mt-en-he", path: "config.json" });
    expect(parseModelUrl("https://huggingface.co/x/y/resolve/main/config.json", BASE)).toBeNull();
    expect(parseModelUrl(`${BASE}opus-mt-en-he/../secret`, BASE)).toBeNull();
    expect(parseModelUrl(`${BASE}config.json`, BASE)).toBeNull();
  });

  it("stores a file only when its size and sha256 match the registry, and serves it back from OPFS", async () => {
    const e = await entryWith({ "config.json": { text: '{"a":1}', dtype: "config" }, "onnx/m_quantized.onnx": { text: "weights!", dtype: "q8" } });
    const cache = createModelCache({ base: BASE, registry: new Map([[e.id, e]]), root: async () => root as unknown as FileSystemDirectoryHandle, fallback: async () => fallback });
    await cache.put(`${BASE}opus-mt-en-he/onnx/m_quantized.onnx`, new Response("weights!"));
    await cache.put(`${BASE}opus-mt-en-he/config.json`, new Response('{"a":1}'));
    const hit = await cache.match(`${BASE}opus-mt-en-he/onnx/m_quantized.onnx`);
    expect(await hit?.text()).toBe("weights!");
    expect(await isModelCached(root as unknown as FileSystemDirectoryHandle, e, "q8")).toBe(true);
    expect(await isModelCached(root as unknown as FileSystemDirectoryHandle, e, "q4f16")).toBe(false);
    await removeCachedModel(root as unknown as FileSystemDirectoryHandle, e.id);
    expect(await cache.match(`${BASE}opus-mt-en-he/config.json`)).toBeUndefined();
  });

  it("refuses a tampered, truncated or unlisted file", async () => {
    const e = await entryWith({ "onnx/m_quantized.onnx": { text: "weights!", dtype: "q8" } });
    const cache = createModelCache({ base: BASE, registry: new Map([[e.id, e]]), root: async () => root as unknown as FileSystemDirectoryHandle, fallback: async () => fallback });
    await expect(cache.put(`${BASE}opus-mt-en-he/onnx/m_quantized.onnx`, new Response("weightz!"))).rejects.toThrow(/checksum mismatch/);
    await expect(cache.put(`${BASE}opus-mt-en-he/onnx/m_quantized.onnx`, new Response("weights"))).rejects.toThrow(/expected 8/);
    await expect(cache.put(`${BASE}opus-mt-en-he/onnx/other.onnx`, new Response("x"))).rejects.toThrow(/not in models\/registry.json/);
    expect(await cache.match(`${BASE}opus-mt-en-he/onnx/m_quantized.onnx`)).toBeUndefined();
  });

  it("leaves every other model to the Cache API", async () => {
    const cache = createModelCache({ base: BASE, registry: new Map(), root: async () => root as unknown as FileSystemDirectoryHandle, fallback: async () => fallback });
    const hf = "https://huggingface.co/onnx-community/whisper-tiny/resolve/main/config.json";
    await cache.put(hf, new Response("{}"));
    await cache.match(hf);
    expect(fallback.put).toHaveBeenCalledWith(hf, expect.any(Response));
    expect(fallback.match).toHaveBeenCalledWith(hf);
  });
});
