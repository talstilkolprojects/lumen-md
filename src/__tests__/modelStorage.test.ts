import { describe, it, expect, vi, afterEach } from "vitest";

const unload = vi.hoisted(() => vi.fn(async () => {}));
const unloadTf = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../ai/webllmEngine", () => ({ unloadWebLlm: unload }));
vi.mock("../ai/transformersEngine", () => ({ unloadTransformers: unloadTf }));

import { cacheKindOf, clearModelCaches, modelCacheNames, storageEstimate } from "../ai/modelStorage";

function fakeCaches(names: string[]) {
  const live = new Set(names);
  return {
    live,
    api: {
      keys: async () => [...live],
      delete: async (n: string) => live.delete(n),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  unload.mockClear();
  unloadTf.mockClear();
});

describe("model storage (plan 5.7)", () => {
  it("knows which caches belong to the model libraries", () => {
    expect(cacheKindOf("webllm/model")).toBe("webllm");
    expect(cacheKindOf("webllm/wasm")).toBe("webllm");
    expect(cacheKindOf("transformers-cache")).toBe("transformers");
    expect(cacheKindOf("workbox-precache-v2")).toBeNull();
    expect(cacheKindOf("lumen-runtime")).toBeNull();
  });

  it("clears one library's caches only, unloading that library's worker first", async () => {
    const c = fakeCaches(["webllm/model", "webllm/config", "transformers-cache", "workbox-precache-v2"]);
    vi.stubGlobal("caches", c.api);
    expect(await modelCacheNames()).toEqual({ webllm: ["webllm/model", "webllm/config"], transformers: ["transformers-cache"] });
    expect(await clearModelCaches("webllm")).toBe(2);
    expect(unload).toHaveBeenCalledTimes(1);
    expect(unloadTf).not.toHaveBeenCalled();
    expect([...c.live]).toEqual(["transformers-cache", "workbox-precache-v2"]);
    expect(await clearModelCaches("transformers")).toBe(1);
    expect(unload).toHaveBeenCalledTimes(1);
    expect(unloadTf).toHaveBeenCalledTimes(1);
    expect([...c.live]).toEqual(["workbox-precache-v2"]);
  });

  it("reports usage and quota, or null when the browser can't", async () => {
    vi.stubGlobal("navigator", { storage: { estimate: async () => ({ usage: 5, quota: 100, usageDetails: { caches: 4 } }), persisted: async () => true } });
    expect(await storageEstimate()).toEqual({ usage: 5, quota: 100, caches: 4, persisted: true });
    vi.stubGlobal("navigator", {});
    expect(await storageEstimate()).toBeNull();
  });
});
