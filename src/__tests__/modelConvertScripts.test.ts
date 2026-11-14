/**
 * The model-convert workflow's helpers (plan 6.0): which files are published,
 * their manifest, and registry edits that keep the file's formatting.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain .mjs scripts without type declarations
import { buildManifest, dtypeOf, keepFile, TARGETS } from "../../scripts/models/manifest.mjs";
// @ts-expect-error — plain .mjs scripts without type declarations
import { formatEntry, upsertEntries, REGISTRY } from "../../scripts/models/registry-edit.mjs";

describe("published files", () => {
  it("names each transformers.js dtype by its file suffix", () => {
    expect(dtypeOf("encoder_model.onnx")).toBe("fp32");
    expect(dtypeOf("encoder_model_quantized.onnx")).toBe("q8");
    expect(dtypeOf("decoder_model_merged_q4f16.onnx")).toBe("q4f16");
    expect(dtypeOf("model_fp16.onnx")).toBe("fp16");
    expect(dtypeOf("config.json")).toBeNull();
  });

  it("keeps configs and the q8 / q4f16 ONNX files, drops weights and other dtypes", () => {
    expect(TARGETS.keep).toEqual(["q8", "q4f16"]);
    for (const f of ["config.json", "tokenizer.json", "generation_config.json", "preprocessor_config.json", "onnx/model_quantized.onnx", "onnx/model_q4f16.onnx"]) expect(keepFile(f), f).toBe(true);
    for (const f of ["onnx/model.onnx", "onnx/model_fp16.onnx", "onnx/model_int8.onnx", "pytorch_model.bin", "model.safetensors", "source.spm", "manifest.json", ".gitattributes"]) expect(keepFile(f), f).toBe(false);
  });

  it("writes a manifest with sha256, size, licence and attribution for every file, and prunes the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lumen-manifest-"));
    mkdirSync(join(dir, "onnx"));
    writeFileSync(join(dir, "config.json"), "{}");
    writeFileSync(join(dir, "onnx", "model_quantized.onnx"), "q8");
    writeFileSync(join(dir, "onnx", "model.onnx"), "fp32 weights");
    const m = await buildManifest({ dir, id: "dictabert-ner", revision: "abc", prune: true });
    expect(m.license).toBe("CC-BY-4.0");
    expect(m.files.map((f: { path: string }) => f.path)).toEqual(["config.json", "onnx/model_quantized.onnx"]);
    for (const f of m.files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.bytes).toBeGreaterThan(0);
      expect(f.license).toBe("CC-BY-4.0");
      expect(f.attribution).toMatch(/DICTA/);
    }
    expect(existsSync(join(dir, "onnx", "model.onnx"))).toBe(false);
  });

  it("every target has an expected licence and attribution, and a smoke test", () => {
    for (const t of TARGETS.models) {
      expect(t.license, t.id).toMatch(/^(Apache-2\.0|CC-BY-4\.0)$/);
      expect(t.attribution.length, t.id).toBeGreaterThan(40);
      expect(t.smoke, t.id).toBeTruthy();
    }
  });
});

describe("registry edits keep the file's formatting", () => {
  it("replaces one entry in place and touches nothing else", () => {
    const text = readFileSync(REGISTRY, "utf8");
    const reg = JSON.parse(text);
    const entry = { ...reg.models.find((m: { id: string }) => m.id === "dictabert-ner"), size: "123 MB (q8)" };
    const out = upsertEntries(text, [entry], undefined);
    const changed = out.split("\n").filter((l: string, i: number) => l !== text.split("\n")[i]);
    expect(changed).toEqual(['      "size": "123 MB (q8)",']);
    expect(JSON.parse(out).models.length).toBe(reg.models.length);
  });

  it("formats string arrays on one line and files one per line", () => {
    const block = formatEntry({ id: "x", match: ["a", "b"], files: [{ path: "c.json", bytes: 1 }] });
    expect(block).toContain('"match": ["a", "b"]');
    expect(block).toContain('        {"path":"c.json","bytes":1}');
    expect(() => JSON.parse(`{"models":[\n${block}\n]}`)).not.toThrow();
  });
});
