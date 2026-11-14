/**
 * Plan W4.14 — model hosting without depending on Hugging Face: the source
 * chain (Hugging Face → Lumen's mirror → the user's copy), sha256 on every
 * source, the library-cache prefill, files picked on the device, and the
 * gap check over the real registry.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GITHUB_RELEASE_MAX_BYTES,
  ModelSourcesError,
  assetName,
  candidates,
  ensureModelFiles,
  fetchVerified,
  findHosted,
  hostingGaps,
  importLocalModelFiles,
  libraryKey,
  mirrorGap,
  mirrorMessages,
  pathFromAsset,
  readUserSource,
  releaseTag,
  silentHfOnly,
  wantsFile,
  writeUserSource,
  type CacheStore,
  type HostedModel,
} from "../ai/modelHosting";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);

const CONFIG = bytes('{"model_type":"whisper"}');
const WEIGHTS = bytes("pretend-onnx-weights-0123456789");
const MIRROR = "https://mirror.example.com";
const USER = "https://nas.example.com/models";

const model: HostedModel = {
  id: "onnx-community/whisper-base",
  class: "allowed",
  delivery: "download",
  runs: "browser",
  hosting: { hf: "onnx-community/whisper-base", revision: "0123456789abcdef0123456789abcdef01234567", cache: "transformers-cache" },
  files: [
    { path: "config.json", sha256: sha(CONFIG), bytes: CONFIG.length, dtype: "config" },
    { path: "onnx/encoder_model_quantized.onnx", sha256: sha(WEIGHTS), bytes: WEIGHTS.length, dtype: "q8" },
  ],
};

/** A fake network: which URLs answer with what; everything else is "blocked" (a TypeError, like a CSP / DNS failure). */
function network(routes: Record<string, Uint8Array | number>) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const r = routes[url];
    if (r === undefined) throw new TypeError("Failed to fetch");
    if (typeof r === "number") return new Response("no", { status: r });
    return new Response(r.slice());
  };
  return { fetch, calls };
}

function memoryCaches() {
  const stores = new Map<string, Map<string, Uint8Array>>();
  const open = async (name: string): Promise<CacheStore> => {
    const m = stores.get(name) ?? new Map<string, Uint8Array>();
    stores.set(name, m);
    return {
      match: async (k) => (m.has(k) ? new Response(m.get(k)!.slice()) : undefined),
      put: async (k, res) => {
        m.set(k, new Uint8Array(await res.arrayBuffer()));
      },
    };
  };
  return { open, stores };
}

const hf = (path: string) => `https://huggingface.co/onnx-community/whisper-base/resolve/0123456789abcdef0123456789abcdef01234567/${path}`;
const mirror = (path: string) => `${MIRROR}/models-onnx-community-whisper-base/${path}`;
const user = (path: string) => `${USER}/models-onnx-community-whisper-base/${assetName(path)}`;

describe("W4.14 sources, in order", () => {
  it("names Hugging Face at the pinned revision, then the mirror, then the user's copy", () => {
    const c = candidates(model, model.files![1], { mirror: MIRROR + "/", user: USER });
    expect(c.map((x) => x.kind)).toEqual(["hf", "mirror", "user"]);
    expect(c[0].url).toBe(hf("onnx/encoder_model_quantized.onnx"));
    expect(c[1].url).toBe(mirror("onnx/encoder_model_quantized.onnx"));
    expect(c[2].url).toBe(user("onnx/encoder_model_quantized.onnx"));
    expect(releaseTag(model)).toBe("models-onnx-community-whisper-base");
  });

  it("a file without a sha256 comes only from the pinned Hugging Face commit, never a mirror", () => {
    const f = { path: "tokens.txt", sha256: "", bytes: 10 };
    expect(candidates(model, f, { mirror: MIRROR, user: USER }).map((c) => c.kind)).toEqual(["hf"]);
    const unpinned = { ...model, hosting: { ...model.hosting, revision: null } };
    expect(candidates(unpinned, f, { mirror: MIRROR, user: USER })).toEqual([]);
  });

  it("refuses paths that climb out of the model folder", () => {
    expect(candidates(model, { path: "../secrets", sha256: sha(WEIGHTS), bytes: 1 }, { mirror: MIRROR, user: null })).toEqual([]);
  });

  it("flattens release asset names and reads them back", () => {
    expect(assetName("onnx/encoder_model.onnx")).toBe("onnx__encoder_model.onnx");
    expect(pathFromAsset("onnx__encoder_model.onnx")).toBe("onnx/encoder_model.onnx");
  });
});

describe("W4.14 every source is checked by sha256", () => {
  const f = model.files![1];

  it("Hugging Face blocked: the file comes from the mirror, verified", async () => {
    const net = network({ [mirror(f.path)]: WEIGHTS });
    const got = await fetchVerified(f, candidates(model, f, { mirror: MIRROR, user: USER }), { fetch: net.fetch });
    expect(got.source.kind).toBe("mirror");
    expect(sha(got.data)).toBe(f.sha256);
    expect(got.attempts).toEqual([{ kind: "hf", url: hf(f.path), error: "Failed to fetch" }]);
  });

  it("a mirror serving other bytes is skipped; the user's copy is used", async () => {
    const tampered = bytes("pretend-onnx-weights-XXXXXXXXXX");
    expect(tampered.length).toBe(WEIGHTS.length);
    const net = network({ [hf(f.path)]: 451, [mirror(f.path)]: tampered, [user(f.path)]: WEIGHTS });
    const got = await fetchVerified(f, candidates(model, f, { mirror: MIRROR, user: USER }), { fetch: net.fetch });
    expect(got.source.kind).toBe("user");
    expect(got.attempts.map((a) => a.error.split(" ")[0])).toEqual(["HTTP", "sha256"]);
    expect(got.attempts[0].error).toBe("HTTP 451");
  });

  it("a short download is caught by its size before hashing", async () => {
    const net = network({ [hf(f.path)]: WEIGHTS.slice(0, 5) });
    await expect(fetchVerified(f, candidates(model, f, { mirror: null, user: null }), { fetch: net.fetch })).rejects.toThrow(/5 bytes, expected/);
  });

  it("no source with the right bytes: ModelSourcesError lists every attempt", async () => {
    const net = network({});
    const err = await fetchVerified(f, candidates(model, f, { mirror: MIRROR, user: USER }), { fetch: net.fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelSourcesError);
    expect((err as ModelSourcesError).attempts.map((a) => a.kind)).toEqual(["hf", "mirror", "user"]);
  });

  it("an abort stops at once instead of trying the next source", async () => {
    const ctl = new AbortController();
    const fetch = async () => {
      ctl.abort();
      throw new DOMException("aborted", "AbortError");
    };
    await expect(fetchVerified(f, candidates(model, f, { mirror: MIRROR, user: null }), { fetch, signal: ctl.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("progress is taken back for a rejected download", async () => {
    let n = 0;
    const net = network({ [hf(f.path)]: bytes("pretend-onnx-weights-XXXXXXXXXX"), [mirror(f.path)]: WEIGHTS });
    await fetchVerified(f, candidates(model, f, { mirror: MIRROR, user: null }), { fetch: net.fetch, onBytes: (d) => (n += d) });
    expect(n).toBe(WEIGHTS.length);
  });
});

describe("W4.14 prefill: the library finds the verified files in its cache", () => {
  it("with huggingface.co blocked, every file lands under the URL transformers.js asks for", async () => {
    const net = network({ [mirror("config.json")]: CONFIG, [mirror("onnx/encoder_model_quantized.onnx")]: WEIGHTS });
    const caches = memoryCaches();
    const report = await ensureModelFiles(model, { fetch: net.fetch, open: caches.open, sources: { mirror: MIRROR, user: null } });
    expect(report.fetched).toEqual([
      { path: "config.json", kind: "mirror" },
      { path: "onnx/encoder_model_quantized.onnx", kind: "mirror" },
    ]);
    const store = caches.stores.get("transformers-cache")!;
    const key = "https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/encoder_model_quantized.onnx";
    expect(libraryKey(model, model.files![1])).toBe(key);
    expect(sha(store.get(key)!)).toBe(model.files![1].sha256);
    expect(net.calls.filter((u) => u.includes("huggingface.co"))).toHaveLength(2); // tried, blocked
    // A second load asks nobody.
    const again = await ensureModelFiles(model, { fetch: net.fetch, open: caches.open, sources: { mirror: MIRROR, user: null } });
    expect(again).toEqual({ cached: 2, fetched: [], skipped: 0 });
    expect(net.calls).toHaveLength(4);
  });

  it("only the files of the dtype being loaded", async () => {
    const net = network({ [hf("config.json")]: CONFIG, [hf("onnx/encoder_model_quantized.onnx")]: WEIGHTS });
    const caches = memoryCaches();
    const r = await ensureModelFiles(model, { fetch: net.fetch, open: caches.open, sources: { mirror: null, user: null }, filter: (f) => wantsFile(f.path, "fp32") });
    expect(r.fetched.map((x) => x.path)).toEqual(["config.json"]);
    expect(wantsFile("onnx/decoder_model_merged_q4.onnx", { encoder_model: "fp32", decoder_model_merged: "q4" })).toBe(true);
    expect(wantsFile("onnx/decoder_model_merged.onnx", { encoder_model: "fp32", decoder_model_merged: "q4" })).toBe(false);
    expect(wantsFile("onnx/encoder_model.onnx", { encoder_model: "fp32", decoder_model_merged: "q4" })).toBe(true);
    expect(wantsFile("onnx/model_q4f16.onnx_data", "q4f16")).toBe(true);
    expect(wantsFile("tokenizer.json", "q8")).toBe(true);
  });

  it("web-llm: the model lib goes to webllm/wasm under its own URL, the config to webllm/config", async () => {
    const LIB = bytes("wasm-lib");
    const CFG = bytes("{}");
    const lib = "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_80/Qwen3-0.6B-q4f16_1-ctx4k_cs1k-webgpu.wasm";
    const mlc: HostedModel = {
      id: "Qwen3-0.6B",
      hosting: { hf: "mlc-ai/Qwen3-0.6B-q4f16_1-MLC", revision: null, cache: "webllm/model", lib },
      files: [
        { path: "mlc-chat-config.json", sha256: sha(CFG), bytes: CFG.length, cache: "webllm/config" },
        { path: "lib/Qwen3-0.6B-q4f16_1-ctx4k_cs1k-webgpu.wasm", sha256: sha(LIB), bytes: LIB.length, key: lib, cache: "webllm/wasm" },
      ],
    };
    const tag = "models-qwen3-0.6b";
    const net = network({ [`${MIRROR}/${tag}/mlc-chat-config.json`]: CFG, [`${MIRROR}/${tag}/lib/Qwen3-0.6B-q4f16_1-ctx4k_cs1k-webgpu.wasm`]: LIB });
    const caches = memoryCaches();
    await ensureModelFiles(mlc, { fetch: net.fetch, open: caches.open, sources: { mirror: MIRROR, user: null } });
    expect([...caches.stores.get("webllm/wasm")!.keys()]).toEqual([lib]);
    expect([...caches.stores.get("webllm/config")!.keys()]).toEqual(["https://huggingface.co/mlc-ai/Qwen3-0.6B-q4f16_1-MLC/resolve/main/mlc-chat-config.json"]);
    expect(findHosted([mlc], "Qwen3-0.6B-q4f16_1-MLC")).toBe(mlc);
  });
});

describe("W4.14 the user's own source", () => {
  it("files picked on the device are kept only when size and sha256 match the registry", async () => {
    const caches = memoryCaches();
    const blob = (name: string, b: Uint8Array) => ({ name, size: b.length, arrayBuffer: async () => b.slice().buffer as ArrayBuffer });
    const res = await importLocalModelFiles([blob("whatever.onnx", WEIGHTS), blob("cfg.json", CONFIG), blob("other.bin", bytes("nope"))], [model], { open: caches.open });
    expect(res.stored).toEqual([
      { model: model.id, path: "onnx/encoder_model_quantized.onnx" },
      { model: model.id, path: "config.json" },
    ]);
    expect(res.unknown).toEqual(["other.bin"]);
  });

  it("the URL is kept in a cache the workers can read; only http(s)", async () => {
    const caches = memoryCaches();
    expect(await writeUserSource(" https://nas.example.com/models/ ", caches.open)).toBe("https://nas.example.com/models");
    expect(await readUserSource(caches.open)).toBe("https://nas.example.com/models");
    expect(await writeUserSource("javascript:alert(1)", caches.open)).toBeNull();
    expect(await readUserSource(caches.open)).toBeNull();
  });
});

describe("W4.14 the registry", () => {
  const registry = JSON.parse(readFileSync(join(__dirname, "../../models/registry.json"), "utf8")) as { hosting: { order: string[] }; models: Array<HostedModel & { files?: Array<{ sha256: string; bytes: number; path: string }> }> };

  it("0 published files without a sha256 and size, none over GitHub's 2 GiB", () => {
    const files = registry.models.flatMap((m) => (m.files ?? []).map((f) => ({ id: m.id, ...f })));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f.sha256, `${f.id}/${f.path}`).toMatch(/^[0-9a-f]{64}$/);
      expect(f.bytes, `${f.id}/${f.path}`).toBeGreaterThan(0);
      expect(f.bytes, `${f.id}/${f.path}`).toBeLessThanOrEqual(GITHUB_RELEASE_MAX_BYTES);
    }
  });

  it("every downloadable model names where it is hosted, in the order hf → mirror → user", () => {
    expect(registry.hosting.order).toEqual(["hf", "mirror", "user"]);
    for (const m of registry.models.filter((x) => x.delivery === "download")) {
      expect(m.hosting, m.id).toBeTruthy();
      expect(!!m.hosting!.hf || m.hosting!.via === "converted", m.id).toBe(true);
    }
  });

  it("the gap check names what is not pinned yet (the owner's --pin) and nothing that is", () => {
    const gaps = hostingGaps(registry.models);
    const nakdimon = registry.models.find((m) => m.id === "nakdimon")!;
    expect(hostingGaps([nakdimon])).toEqual([]);
    expect(gaps.some((g) => g.id === "nakdimon")).toBe(false);
    const said = gaps.map((g) => `${g.id}: ${g.problem}`);
    expect(said.includes("ivrit-ai/zipformer2-66m-streaming-he: sherpa-onnx/tokens.txt: no sha256 (taken only from the pinned Hugging Face revision)")).toBe(true);
    expect(said.includes("Qwen3-0.6B: Hugging Face revision not pinned")).toBe(true);
    // The zipformer's three pinned files are not listed: they are verifiable already.
    expect(said.filter((s) => s.startsWith("ivrit-ai/zipformer2-66m-streaming-he"))).toHaveLength(1);
  });
});

describe("W6.33 no model is only on Hugging Face without a message", () => {
  const read = (p: string) => JSON.parse(readFileSync(join(__dirname, "../..", p), "utf8")) as Record<string, string>;
  const models = (read("models/registry.json") as unknown as { models: HostedModel[] }).models;
  const sha = "a".repeat(64);
  const pinned: HostedModel = {
    id: "x/m",
    class: "allowed",
    delivery: "download",
    runs: "browser",
    hosting: { hf: "x/m", revision: "b".repeat(40), cache: "transformers-cache" },
    files: [{ path: "config.json", sha256: sha, bytes: 10 }],
  };

  it("names why a model can't come from the mirror", () => {
    expect(mirrorGap(pinned)).toBeNull();
    expect(mirrorGap({ ...pinned, hosting: undefined })).toBe("no-hosting");
    expect(mirrorGap({ ...pinned, files: [] })).toBe("not-pinned");
    expect(mirrorGap({ ...pinned, hosting: { ...pinned.hosting, revision: null } })).toBe("not-pinned");
    expect(mirrorGap({ ...pinned, hosting: { ...pinned.hosting, unpinned: ["tokens.txt"] } })).toBe("unhashed");
    expect(mirrorGap({ ...pinned, files: [{ path: "w.onnx", sha256: sha, bytes: GITHUB_RELEASE_MAX_BYTES + 1 }] })).toBe("over-2gib");
  });

  it("every one of the 24 default models with a gap, and every variant left out, has its message in English and Hebrew", () => {
    const en = read("src/i18n/lazy/modelSources.json");
    const he = read("src/i18n/locales/he/common.json");
    const msgs = mirrorMessages(models);
    expect(msgs.length).toBeGreaterThan(0);
    expect(silentHfOnly(models, en)).toEqual([]);
    expect(silentHfOnly(models, he)).toEqual([]);
    // A missing string is caught.
    expect(silentHfOnly(models, {}).length).toBe(msgs.length);
  });

  it("large-v3-turbo leaves out its fp32 encoder (over 2 GiB) and says it loads fp16 instead", () => {
    const turbo = models.find((m) => m.id === "onnx-community/whisper-large-v3-turbo")!;
    expect(turbo.hosting?.dtypes).not.toContain("fp32");
    expect(turbo.hosting?.omitted).toEqual([{ dtype: "fp32", reason: "over-2gib", instead: "fp16" }]);
    expect(mirrorMessages(models).filter((x) => x.gap === "omitted")).toEqual([
      { id: turbo.id, gap: "omitted", key: "modelSources.omitted.over2gib", params: { model: turbo.id, dtype: "fp32", instead: "fp16" } },
    ]);
  });
});
