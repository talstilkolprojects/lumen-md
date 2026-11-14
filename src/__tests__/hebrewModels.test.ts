/** T27 — Hebrew model catalog, Hebrew-aware picks, and the answer-language rule. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { autoPickable, hebrewSupportOf, licenceClassOf, ollamaLicenceNotice, prefersHebrew, recommendOllamaModel } from "../ai/modelCatalog";
import { pickModel, pickToolModel } from "../agents/executors/ollama";
import { recommendWebLlmModel, type Hardware } from "../ai/modelManager";
import { sameScript } from "../agents/runtime";

describe("model catalog", () => {
  it("recommends the best Hebrew model that fits the RAM", () => {
    // Only open-licence models are suggested (plan 1.7): no Aya (NC), no Gemma/Llama by default.
    expect(recommendOllamaModel({ hebrew: true, ramGB: 16 }).name).toBe("qwen3:14b");
    expect(recommendOllamaModel({ hebrew: true, ramGB: 8 }).name).toBe("qwen3:8b");
    expect(recommendOllamaModel({ hebrew: true, ramGB: 4 }).name).toBe("qwen3:4b");
    for (const ram of [2, 4, 8, 12, 16, 64]) for (const hebrew of [true, false]) {
      const r = recommendOllamaModel({ hebrew, ramGB: ram });
      expect(r.licence?.class).toBe("allowed");
      expect(r.recommend).not.toBe(false);
    }
    expect(recommendOllamaModel({ hebrew: true, ramGB: 4 }).hebrew).not.toBe("none");
    expect(recommendOllamaModel({ hebrew: false, ramGB: 16 }).name).toBe("qwen2.5:7b");
    expect(recommendOllamaModel({ hebrew: true, ramGB: 16, tools: true }).tools).toBe(true);
  });

  it("knows installed names, tags and families", () => {
    expect(hebrewSupportOf("aya-expanse:8b")).toBe("strong");
    expect(hebrewSupportOf("gemma3:latest")).toBe("strong");
    expect(hebrewSupportOf("llama3.2:3b")).toBe("basic");
    expect(hebrewSupportOf("dictalm2.0-instruct:q4")).toBe("strong");
    expect(hebrewSupportOf("mystery:1b")).toBeNull();
  });

  it("detects Hebrew notes from the locale or the note", () => {
    expect(prefersHebrew("he", "")).toBe(true);
    expect(prefersHebrew("en", "שלום לכם, זה פתק ארוך מספיק בעברית כדי להחליט")).toBe(true);
    expect(prefersHebrew("en", "An English note that is long enough to decide.")).toBe(false);
    expect(prefersHebrew("en", "שלום")).toBe(false);
  });
});

describe("Hebrew-aware picks", () => {
  const installed = [
    { name: "granite3.3:8b", params: 8.2, family: "granite" },
    { name: "llama3.1:8b", params: 8, family: "llama" },
    { name: "aya-expanse:8b", params: 8, family: "cohere" },
    { name: "qwen2.5:7b", params: 7.6, family: "qwen2" },
  ];
  it("prefers the model with better Hebrew in the same tier", () => {
    expect(pickModel("small", installed, null, { hebrew: true })).toBe("qwen2.5:7b");
    expect(pickModel("small", installed, null)).toBe("granite3.3:8b");
  });
  it("keeps the Hebrew ranking when a tool agent falls back to a tool-capable model", () => {
    const tools = (m: { name: string }) => !m.name.startsWith("granite");
    expect(pickToolModel("small", installed, tools, { hebrew: true })).toBe("qwen2.5:7b");
    expect(pickToolModel("small", installed, tools)).toBe("qwen2.5:7b");
    expect(pickToolModel("small", installed, () => false, { hebrew: true })).toBeNull();
  });
  it("still honours an explicitly configured model of the tier", () => {
    expect(pickModel("small", installed, "llama3.1:8b", { hebrew: true })).toBe("llama3.1:8b");
    expect(pickModel("small", installed, "aya-expanse:8b")).toBe("aya-expanse:8b");
  });
  it("prefers a multilingual in-browser model", () => {
    const hw: Hardware = { webgpu: true, f16: true, maxBufferMB: 4096, deviceMemoryGB: 16, cores: 8, mobile: false };
    expect(recommendWebLlmModel("small", hw, { multilingual: true })).toMatch(/Qwen3-4B|Llama-3\.2-3B/);
  });
});

describe("custom-licence models are never picked on their own (plan 1.7)", () => {
  it("knows the licence class of installed names, tags and families", () => {
    expect(licenceClassOf("qwen2.5:7b")).toBe("allowed");
    expect(licenceClassOf("qwen3:30b")).toBe("allowed");
    expect(licenceClassOf("llama3.1:70b")).toBe("conditional");
    expect(licenceClassOf("gemma3:latest")).toBe("conditional");
    expect(licenceClassOf("llama3.3:70b")).toBe("conditional");
    expect(licenceClassOf("gemma2:9b")).toBe("conditional");
    expect(licenceClassOf("hermes3:8b")).toBe("conditional");
    expect(licenceClassOf("hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M")).toBe("conditional");
    expect(licenceClassOf("aya-expanse:32b")).toBe("forbidden");
    expect(licenceClassOf("mistral:7b")).toBeNull();
    // Sizes of an open family under another licence do not inherit it.
    expect(licenceClassOf("qwen2.5:72b")).toBe("forbidden");
    expect(licenceClassOf("qwen2.5:72b-instruct-q4_K_M")).toBe("forbidden");
    expect(licenceClassOf("qwen2.5:3b")).toBe("forbidden");
    expect(licenceClassOf("qwen2.5:32b")).toBe("allowed");
    expect(licenceClassOf("qwen2.5:14b")).toBe("allowed");
    expect(licenceClassOf("qwen2.5-coder:3b")).toBe("forbidden");
    // Cohere's Command models are CC-BY-NC, like Aya.
    for (const n of ["command-r:latest", "command-r:35b", "command-r-plus:104b", "command-r7b:7b", "command-a:111b", "hf.co/CohereForAI/c4ai-command-r-v01-GGUF:Q4_K_M"]) expect([n, licenceClassOf(n)]).toEqual([n, "forbidden"]);
    expect(pickModel("medium", [{ name: "command-r:35b", params: 35, family: "command-r" }, { name: "qwen2.5:7b", params: 7.6, family: "qwen2" }], null)).toBe("qwen2.5:7b");
    expect(autoPickable("qwen2.5-coder:3b-instruct-q4_K_M")).toBe(false);
    expect(autoPickable("mistral:7b")).toBe(true);
    expect(autoPickable("llama3.1:8b")).toBe(false);
  });

  it("classifies vendor-prefixed Hugging Face names too", () => {
    expect(licenceClassOf("hf.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF:Q4_K_M")).toBe("conditional");
    expect(licenceClassOf("hf.co/bartowski/Qwen2.5-72B-Instruct-GGUF:Q4_K_M")).toBe("forbidden");
    expect(licenceClassOf("hf.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF:Q4_K_M")).toBe("forbidden");
    expect(licenceClassOf("hf.co/unsloth/gemma-3-4b-it-GGUF:Q4_K_M")).toBe("conditional");
    expect(licenceClassOf("dolphin-llama3:8b")).toBe("conditional");
    // Hermes takes its base's licence: Llama-based is conditional, Mistral-based is open.
    expect(licenceClassOf("hf.co/NousResearch/Hermes-3-Llama-3.1-8B-GGUF:Q4_K_M")).toBe("conditional");
    expect(licenceClassOf("hermes3:8b")).toBe("conditional");
    expect(licenceClassOf("hf.co/NousResearch/Hermes-2-Pro-Mistral-7B-GGUF:Q4_K_M")).toBeNull();
    expect(autoPickable("hf.co/NousResearch/Hermes-2-Pro-Mistral-7B-GGUF:Q4_K_M")).toBe(true);
    expect(licenceClassOf("hf.co/Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M")).toBeNull();
    expect(licenceClassOf("tinyllama:1.1b")).toBeNull(); // Apache-2.0
    expect(autoPickable("hf.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF:Q4_K_M")).toBe(false);
  });

  it("names the licence a hand-picked Ollama model needs a notice for", () => {
    expect(ollamaLicenceNotice("llama3.1:8b")).toEqual({ class: "conditional", name: "Llama 3.1 Community License" });
    expect(ollamaLicenceNotice("gemma2:9b")?.name).toBe("Gemma Terms of Use");
    expect(ollamaLicenceNotice("command-r:35b")?.name).toMatch(/non-commercial/);
    expect(ollamaLicenceNotice("qwen2.5:7b")).toBeNull();
    expect(ollamaLicenceNotice("mistral:7b")).toBeNull();
  });

  it("agrees with models/registry.json on every Ollama name it lists", () => {
    const registry = JSON.parse(readFileSync(resolve(__dirname, "../../models/registry.json"), "utf8")) as { models: Array<{ id: string; class: string; runs: string; match?: string[] }> };
    // Ollama names: the ids of `runs: ollama` entries, and any `name:tag` alias of any entry
    // (browser entries list their Ollama tags in `match`, e.g. qwen2.5-coder:3b).
    const names = registry.models.flatMap((m) =>
      [m.id, ...(m.match ?? [])]
        .filter((n) => n.includes(":") || n.startsWith("hf.co/") || (m.runs === "ollama" && n === m.id && !/^[A-Z]/.test(n)))
        .map((n) => [n, m.class] as const),
    );
    expect(names.map(([n]) => n)).toEqual(expect.arrayContaining(["qwen2.5-coder:3b", "qwen2.5:3b", "qwen2.5:72b", "aya-expanse:8b", "llama3.1:8b"]));
    for (const [name, cls] of names) expect([name, autoPickable(name)]).toEqual([name, cls === "allowed"]);
  });

  it("a large-tier agent never auto-picks the forbidden qwen2.5:72b", () => {
    const big = [
      { name: "qwen2.5:72b", params: 72.7, family: "qwen2" },
      { name: "qwen2.5:7b", params: 7.6, family: "qwen2" },
    ];
    expect(pickModel("large", big, null)).toBe("qwen2.5:7b");
  });

  const llamaAndQwen = [
    { name: "llama3.1:8b", params: 8, family: "llama" },
    { name: "qwen2.5:7b", params: 7.6, family: "qwen2" },
  ];
  const gemmaAndQwen = [
    { name: "gemma3:12b", params: 12.2, family: "gemma3" },
    { name: "qwen2.5:7b", params: 7.6, family: "qwen2" },
  ];
  it("with no model configured, the larger Llama / in-band Gemma is skipped for the open-licence model", () => {
    expect(pickModel("small", llamaAndQwen, null)).toBe("qwen2.5:7b");
    expect(pickModel("medium", gemmaAndQwen, null)).toBe("qwen2.5:7b");
    expect(pickModel("large", gemmaAndQwen, null)).toBe("qwen2.5:7b");
    expect(pickToolModel("small", llamaAndQwen, () => true)).toBe("qwen2.5:7b");
  });
  it("a configured model outside the requested tier does not open the door to other custom-licence models", () => {
    expect(pickModel("medium", [...gemmaAndQwen, ...llamaAndQwen.slice(0, 1)], "qwen2.5:7b")).toBe("qwen2.5:7b");
  });
  it("the configured custom-licence model is still used, in or out of its tier", () => {
    expect(pickModel("medium", gemmaAndQwen, "gemma3:12b")).toBe("gemma3:12b");
    expect(pickModel("large", gemmaAndQwen, "gemma3:12b")).toBe("gemma3:12b");
    expect(pickToolModel("small", llamaAndQwen, () => true, { configured: "llama3.1:8b" })).toBe("llama3.1:8b");
  });
});

describe("answer in the input's language", () => {
  const he = "פגישת צוות: דנה תשלח את ההצעה ללקוח עד יום חמישי, יואב יבדוק את הבאג.";
  it("rejects a Latin answer to Hebrew input", () => {
    const r = sameScript(he, "Dana will send the proposal to the client by Thursday and Yoav checks the bug.");
    expect(r.ok).toBe(false);
  });
  it("accepts a Hebrew answer, JSON with English keys, and short answers", () => {
    expect(sameScript(he, "דנה תשלח את ההצעה עד יום חמישי").ok).toBe(true);
    expect(sameScript(he, { tasks: [{ title: "לשלוח הצעת מחיר ללקוח", owner: "דנה" }] }).ok).toBe(true);
    expect(sameScript(he, "OK").ok).toBe(true);
    expect(sameScript("An English input sentence here.", "Whatever language answer is fine here").ok).toBe(true);
  });
});

describe("language check exemptions (review fixes)", () => {
  const he = "כתוב לי פונקציית ג׳אווהסקריפט שמחברת שני מספרים ומחזירה את התוצאה, בבקשה.";
  it("does not count code as Latin prose", () => {
    expect(sameScript(he, "```js\nfunction add(a, b) {\n  return a + b; // returns the sum of both numbers\n}\n```").ok).toBe(true);
    expect(sameScript(he, "הנה הפונקציה:\n```js\nfunction add(a, b) { return a + b; }\n```\nהיא מחזירה את הסכום.").ok).toBe(true);
    expect(sameScript(he, "קראו ל־`computeTheTotalAmountOfEverything()` כדי לקבל סכום").ok).toBe(true);
    // Prose outside the code still counts.
    expect(sameScript(he, "Here is the function you asked for, it adds both numbers:\n```js\nadd()\n```").ok).toBe(false);
  });

  it("translation templates are language-independent", async () => {
    const { templaterAgent } = await import("../agents/defs");
    const lang = templaterAgent.language as (i: { text: string; extra: { templateId: string } }) => string;
    expect(lang({ text: "x", extra: { templateId: "he.translate_to_en" } })).toBe("any");
    expect(lang({ text: "x", extra: { templateId: "he.summarize" } })).toBe("input");
  });
});

