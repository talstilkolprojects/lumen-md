/**
 * Plan 7.8 — the model benchmark harness: the numbers it computes, the
 * rules for writing them into models/registry.json, and the engine
 * adapters' contract. The browser run itself is `npm run bench:models`.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
// @ts-expect-error — plain .mjs module without type declarations
import { editDistance, errorRate, normalizeAsr, normalizeOcr, percentile } from "../../scripts/bench/metrics.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { TASKS } from "../../scripts/bench/tasks.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { applyMeasurements, isSoftwareAdapter, refusal } from "../../scripts/bench/registry.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { parseArgs, table } from "../../scripts/bench-models.mjs";

const ROOT = resolve(__dirname, "../..");
const GPU = { userAgent: "Mozilla/5.0 Chrome/141.0.7390.37", webgpu: true, adapter: { vendor: "apple", architecture: "metal-3", device: "", description: "Apple M2" } };
const SWIFTSHADER = { ...GPU, adapter: { vendor: "google", architecture: "swiftshader", device: "", description: "" } };

const row = (over: Record<string, unknown> = {}) => ({
  engine: "bge-rerank",
  set: "retrieval",
  models: ["onnx-community/bge-reranker-v2-m3-ONNX"],
  backend: "webgpu",
  split: "dev",
  at: "2026-11-10",
  limited: false,
  status: "measured",
  device: "webgpu",
  items: 12,
  loadMs: 900,
  prepareMs: 5,
  p50Ms: 40,
  p95Ms: 61,
  rssPeakMB: 1800,
  rssDeltaMB: 650,
  jsHeapPeakMB: 30,
  quality: { "ndcg@10": 0.98 },
  ...over,
});

describe("metrics", () => {
  it("percentiles are nearest-rank", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([], 50)).toBeNull();
  });

  it("edit distance and micro-averaged error rates", () => {
    expect(editDistance("שלום", "שלם")).toBe(1);
    expect(editDistance(["a", "b"], ["a", "c", "b"])).toBe(1);
    const r = errorRate();
    r.add([..."abcd"], [..."abed"]);
    r.add([..."xy"], [..."xy"]);
    expect(r.value).toBeCloseTo(1 / 6);
  });

  it("normalises speech and OCR text as the sets define", () => {
    expect(normalizeAsr("שָׁלוֹם, עוֹלָם! בית־ספר")).toBe("שלום עולם בית ספר");
    expect(normalizeOcr("  שלום \n  עולם ")).toBe("שלום עולם");
  });
});

describe("tasks", () => {
  it("retrieval: nDCG@10 per part and overall", () => {
    const items = [
      { id: "q1", part: "heq", relevant: ["d1"] },
      { id: "q2", part: "heq", relevant: ["d2"] },
    ];
    const s = TASKS.retrieval.score(items, { q1: ["d1", "x"], q2: ["x", "d2"] });
    expect(s["ndcg@10.heq"]).toBeCloseTo((1 + 1 / Math.log2(3)) / 2, 4);
    expect(s["ndcg@10"]).toBe(s["ndcg@10.heq"]);
    expect(TASKS.retrieval.score(items, {})["ndcg@10"]).toBe(0);
  });

  it("retrieval payload carries the query and the unjudged same-article ids only", () => {
    const p = TASKS.retrieval.payload({ items: [{ id: "q1", part: "heq", query: "מתי?", relevant: ["d1"], sameArticle: ["d9"], answers: ["x"] }], corpus: { heq: [{ id: "d1", text: "t" }] } });
    expect(p.items).toEqual([{ id: "q1", part: "heq", input: { query: "מתי?", skip: ["d9"] } }]);
    expect(JSON.stringify(p.items)).not.toContain("relevant");
  });

  it("ocr: CER per condition; nikud lines are reported, not in the headline CER", () => {
    const items = [
      { id: "a", part: "lines", condition: "clean", text: "שלום" },
      { id: "b", part: "lines", condition: "nikud", text: "שָׁלוֹם" },
    ];
    const s = TASKS["ocr-he"].score(items, { a: "שלם", b: "" });
    expect(s["cer.clean"]).toBe(0.25);
    expect(s.cer).toBe(0.25);
    expect(s["cer.nikud"]).toBe(1);
  });

  it("asr: WER and CER after normalisation", () => {
    const s = TASKS["asr-he"].score([{ id: "a", part: "fleurs", text: "שלום עולם." }], { a: "שלום עולם" });
    expect(s.wer).toBe(0);
    expect(s["wer.fleurs"]).toBe(0);
    expect(TASKS["asr-he"].score([{ id: "a", part: "fleurs", text: "שלום עולם" }], { a: "שלום" }).wer).toBe(0.5);
  });

  it("the committed retrieval and OCR dev sets load as the tasks expect", async () => {
    // @ts-expect-error — plain .mjs module without type declarations
    const { loadSet } = await import("../../scripts/lib/golden.mjs");
    const r = loadSet(join(ROOT, "eval/golden"), "retrieval", { split: "dev" });
    expect(r.items.length).toBeGreaterThan(0);
    const p = TASKS.retrieval.payload(r);
    expect(Object.keys(p.shared).length).toBeGreaterThan(0);
    const o = loadSet(join(ROOT, "eval/golden"), "ocr-he", { split: "dev" });
    const op = TASKS["ocr-he"].payload({ items: o.items.slice(0, 1) });
    expect((op.items[0].input as { image: string }).image.startsWith("data:image/png;base64,")).toBe(true);
  });
});

describe("registry", () => {
  const registry = () => JSON.parse(readFileSync(join(ROOT, "models/registry.json"), "utf8")) as { models: Array<{ id: string; measured?: Record<string, Record<string, unknown>> }> };

  it("writes measured.<device> for a full GPU run, and nothing else changes", () => {
    const before = registry();
    const { registry: after, written, skipped } = applyMeasurements(before, [{ ...row(), env: GPU }], GPU);
    expect(skipped).toEqual([]);
    expect(written).toEqual([{ model: "onnx-community/bge-reranker-v2-m3-ONNX", device: "webgpu", engine: "bge-rerank" }]);
    const m = after.models.find((x: { id: string }) => x.id === "onnx-community/bge-reranker-v2-m3-ONNX")!;
    expect(m.measured.webgpu).toMatchObject({ set: "retrieval", split: "dev", items: 12, gpu: "apple metal-3 Apple M2", browser: "Chrome/141.0.7390.37", p95Ms: 61, quality: { "ndcg@10": 0.98 }, tool: "npm run bench:models" });
    const strip = (r: { models: Array<{ id: string; measured?: unknown }> }) => r.models.map(({ measured: _m, ...x }) => x);
    expect(strip(after)).toEqual(strip(before));
    expect(before.models.find((x) => x.id === "onnx-community/bge-reranker-v2-m3-ONNX")!.measured?.webgpu).toBeUndefined();
  });

  it("refuses what is not a real, whole GPU number", () => {
    expect(refusal(row(), GPU)).toBeNull();
    expect(refusal(row({ status: "error" }), GPU)).toBe("status error");
    expect(refusal(row({ status: "partial" }), GPU)).toBe("status partial");
    expect(refusal(row({ limited: true }), GPU)).toMatch(/--limit/);
    expect(refusal(row({ models: [] }), GPU)).toMatch(/baseline/);
    expect(refusal(row({ device: "wasm" }), GPU)).toBe("asked for WebGPU, ran on wasm");
    expect(refusal(row(), SWIFTSHADER)).toMatch(/SwiftShader/);
    expect(refusal(row({ quality: {} }), GPU)).toMatch(/quality/);
    expect(refusal(row({ backend: "wasm", device: "wasm" }), SWIFTSHADER)).toBeNull();
    expect(isSoftwareAdapter(SWIFTSHADER)).toBe(true);
    expect(isSoftwareAdapter(GPU)).toBe(false);
    const { written, skipped } = applyMeasurements(registry(), [row({ models: ["not-a-model"] })], GPU);
    expect(written).toEqual([]);
    expect(skipped[0].reason).toMatch(/not in models\/registry.json/);
  });
});

describe("command line", () => {
  it("parses options and refuses bad ones", () => {
    expect(parseArgs([])).toMatchObject({ engines: null, backends: ["webgpu"], split: "dev", write: false, prime: true, headless: false });
    expect(parseArgs(["--engines", "e5,bm25", "--backends", "webgpu,wasm", "--limit", "2", "--no-prime"])).toMatchObject({ engines: ["e5", "bm25"], backends: ["webgpu", "wasm"], limit: 2, prime: false });
    expect(() => parseArgs(["--backends", "cuda"])).toThrow(/webgpu or wasm/);
    expect(() => parseArgs(["--split", "test"])).toThrow(/--dir/);
    expect(() => parseArgs(["--limit", "0"])).toThrow(/positive/);
  });

  it("prints numbers only", () => {
    const md = table([row(), { engine: "e5", backend: "wasm", set: "retrieval", models: [], status: "error", error: "Error: boom" }]);
    expect(md).toContain("| bge-rerank | webgpu | retrieval | 12 | 900 | 40 | 61 | 1800 | ndcg@10 0.98 | measured |");
    expect(md).toContain("| e5 | (wasm) | retrieval |");
    expect(md).toContain("error: Error: boom");
  });
});

describe("engine adapters", () => {
  const dir = join(ROOT, "src/bench/engines");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  const ids = new Set(JSON.parse(readFileSync(join(ROOT, "models/registry.json"), "utf8")).models.map((m: { id: string }) => m.id));

  it("every engine on this branch: id = file name, a golden set with a task, registry models", () => {
    expect(files.map((f) => f.replace(/\.ts$/, "")).sort()).toEqual(["bge-rerank", "bm25", "e5", "tesseract", "whisper-small", "whisper-tiny", "whisper-turbo"]);
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(/id: "([^"]+)"/.exec(src)?.[1] ?? /id: `([^`]+)`/.exec(src)?.[1], f).toBe(f.replace(/\.ts$/, ""));
      const set = /set: "([^"]+)"/.exec(src)![1];
      expect(Object.keys(TASKS), f).toContain(set);
      expect(readdirSync(join(ROOT, "eval/golden")), f).toContain(set);
    }
    for (const id of ["onnx-community/bge-reranker-v2-m3-ONNX", "Xenova/multilingual-e5-small", "tessdata_fast/heb.traineddata", "tessdata_fast/eng.traineddata", "onnx-community/whisper-tiny", "onnx-community/whisper-small", "onnx-community/whisper-large-v3-turbo"]) expect(ids.has(id), id).toBe(true);
  });

  it("the bench page is not part of the app build", () => {
    const vite = readFileSync(join(ROOT, "vite.config.ts"), "utf8");
    expect(vite).not.toContain("bench/models.html");
    expect(readFileSync(join(ROOT, "index.html"), "utf8")).not.toContain("src/bench");
  });
});
