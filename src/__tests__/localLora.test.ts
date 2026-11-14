/**
 * Plan 6.12 — local LoRA fine-tune: the dataset export (6.12.1), the Mac
 * and NVIDIA scripts (6.12.2, 6.12.3), and the acceptance metric. The
 * training itself runs on the owner's Mac (15.13).
 */
import { describe, it, expect } from "vitest";
import { buildLoraDataset, centroid, chunkProse, cosine, hashPath, macScript, nvidiaScript, sampleOf, splitNotes, styleGain, systemFor } from "../ai/localLora";
import { proseOfNote } from "../ai/styleProfiles";

const para = (n: number, w = "word") => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ");
const notes = Array.from({ length: 40 }, (_, i) => ({ path: `notes/n${i}.md`, text: `---\ntags: [x]\n---\n# Title ${i}\n\n${para(150, "a")}\n\n${para(150, "b")}\n\n\`\`\`js\nconst secret = 1;\n\`\`\`\n` }));

describe("splitNotes", () => {
  it("is deterministic and disjoint, with a held-out part", () => {
    const a = splitNotes(notes);
    const b = splitNotes([...notes].reverse());
    expect(a.heldOut.map((n) => n.path)).toEqual(b.heldOut.map((n) => n.path));
    const all = [...a.train, ...a.valid, ...a.heldOut].map((n) => n.path);
    expect(new Set(all).size).toBe(notes.length);
    expect(a.heldOut.length).toBeGreaterThan(0);
    expect(a.valid.length).toBeGreaterThan(0);
  });

  it("small vaults still get one held-out and one validation note", () => {
    const few = notes.slice(0, 5).filter((n) => hashPath(n.path) % 10 > 1);
    const s = splitNotes(few);
    if (few.length > 2) {
      expect(s.heldOut.length).toBe(1);
      expect(s.valid.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("buildLoraDataset (6.12.1)", () => {
  const ds = buildLoraDataset(notes, { prose: proseOfNote });

  it("writes chat-format JSONL that mlx-lm and PEFT read", () => {
    const lines = ds.train.trim().split("\n");
    expect(lines.length).toBe(ds.stats.trainSamples);
    for (const l of lines) {
      const m = JSON.parse(l).messages;
      expect(m.map((x: { role: string }) => x.role)).toEqual(["system", "user", "assistant"]);
      expect(m[1].content.length).toBeGreaterThan(0);
      expect(m[2].content.length).toBeGreaterThan(0);
    }
    expect(ds.valid.trim().split("\n").length).toBe(ds.stats.validSamples);
  });

  it("never trains on held-out notes, frontmatter or code", () => {
    const held = new Set(ds.heldOut.map((n) => n.path));
    expect(held.size).toBe(ds.stats.heldOut);
    expect(ds.train).not.toContain("tags: [x]");
    expect(ds.train).not.toContain("const secret");
    // The held-out text is the prose only too.
    for (const n of ds.heldOut) expect(n.text).not.toContain("```");
  });

  it("puts the style profile's tone and rules in the system prompt", () => {
    const sys = systemFor({ tone: "dry", rules: ["short sentences"], examples: [], notes: 2, builtAt: "x" });
    expect(sys).toContain("Tone: dry");
    expect(sys).toContain("- short sentences");
    const withProfile = buildLoraDataset(notes, { prose: proseOfNote, profile: { tone: "dry", rules: ["r"], examples: [], notes: 2, builtAt: "x" } });
    expect(JSON.parse(withProfile.train.split("\n")[0]).messages[0].content).toContain("Tone: dry");
  });

  it("skips notes too short to learn from", () => {
    const tiny = buildLoraDataset([{ path: "a.md", text: "too short" }], { prose: proseOfNote });
    expect(tiny.stats).toMatchObject({ notes: 0, trainSamples: 0 });
  });
});

describe("chunkProse / sampleOf", () => {
  it("cuts on paragraphs and splits a sample 40 / 60", () => {
    const chunks = chunkProse(`${para(200)}\n\n${para(200)}\n\n${para(50)}`, 300);
    expect(chunks.length).toBe(2);
    const m = JSON.parse(sampleOf(para(100))).messages;
    expect(m[1].content.split(" ").length).toBe(40);
    expect(m[2].content.split(" ").length).toBe(60);
  });
});

describe("the training scripts (6.12.2, 6.12.3)", () => {
  it("Mac: mlx_lm.lora on Mistral 7B, fuse to GGUF, FROM in a Modelfile, ollama create", () => {
    const s = macScript();
    expect(s).toContain("mlx_lm.lora --model mistralai/Mistral-7B-Instruct-v0.3 --train --data .");
    expect(s).toContain("mlx_lm.fuse");
    expect(s).toContain("--export-gguf");
    expect(s).toMatch(/FROM \.\/lumen-style\.gguf/);
    expect(s).toContain("ollama create lumen-style -f Modelfile");
    expect(s).toContain("scripts/lora/style-eval.mjs");
  });

  it("NVIDIA: PEFT through the Unsloth core (not Studio), convert_lora_to_gguf, ADAPTER", () => {
    const s = nvidiaScript();
    expect(s).toContain("FastLanguageModel.get_peft_model");
    expect(s).toContain("convert_lora_to_gguf.py");
    expect(s).toMatch(/ADAPTER \.\/lumen-style-adapter\.gguf/);
    expect(s).toMatch(/not Unsloth Studio \(AGPL\)/);
    expect(s).not.toMatch(/unsloth[-_]studio|pip install[^\n]*studio/i);
  });
});

describe("the acceptance metric", () => {
  it("cosine to the held-out centroid; pass at ≥ 10 % above the base", () => {
    const held = [[1, 0, 0], [0.9, 0.1, 0]];
    const base = [[0.5, 0.5, 0.5]];
    const close = [[1, 0.05, 0]];
    const r = styleGain(held, base, close);
    expect(r.tuned).toBeGreaterThan(r.base);
    expect(r.gain).toBeGreaterThan(0.1);
    expect(r.pass).toBe(true);
    expect(styleGain(held, base, base)).toMatchObject({ gain: 0, pass: false });
  });

  it("centroid and cosine behave", () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(centroid([[2, 0], [0, 2]])).toEqual([0.5, 0.5]);
  });
});
