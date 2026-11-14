/**
 * Plan 6.11 — layered local summaries: Chrome's Summarizer for English only,
 * a local model (DictaLM for Hebrew in Ollama) in layers, the extractive
 * layer without a model — and every sentence shown is in the source.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => ({ aiKey: null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null }) } }));
vi.mock("../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));

import { extractiveSummary, ground, sections, splitSentences, summarySentences } from "../ai/summarizeCore";
import { summarize } from "../ai/summarize";
import { quoteContained } from "../research/citations";
import { registerExecutor, resetExecutors } from "../agents/executors";
import { fakeExecutor, sequence } from "./helpers/fakeExecutor";

const EN =
  "The council met on Monday to discuss the new library. Members agreed that the building needs a larger reading room. " +
  "The budget for the work was set at two million. Construction will start in the spring and end within a year. " +
  "Residents may send comments until the end of the month.";
const HE = "המועצה התכנסה ביום שני כדי לדון בספרייה החדשה. החברים הסכימו שהבניין צריך אולם קריאה גדול יותר. התקציב לעבודות נקבע על שני מיליון. הבנייה תתחיל באביב ותסתיים בתוך שנה.";

describe("summarizeCore", () => {
  it("splits sentences in Hebrew and English, keeping abbreviations whole", () => {
    expect(splitSentences("שלום עולם. זה משפט שני! ומה עכשיו?")).toEqual(["שלום עולם.", "זה משפט שני!", "ומה עכשיו?"]);
    expect(splitSentences("Dr. Cohen came. Then he left.\n\n# Heading\n\nNew paragraph")).toEqual(["Dr. Cohen came.", "Then he left.", "Heading", "New paragraph"]);
    expect(summarySentences("- First point here.\n- Second point. Third one.")).toEqual(["First point here.", "Second point.", "Third one."]);
  });

  it("cuts a long text into sections of whole paragraphs", () => {
    const para = (i: number) => `Paragraph ${i}. ` + "Some words here. ".repeat(40);
    const text = Array.from({ length: 12 }, (_, i) => para(i)).join("\n\n");
    const parts = sections(text, 2000);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.every((p) => p.length <= 2000)).toBe(true);
    expect(parts.join("\n\n").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " ").trim());
  });

  it("the extractive layer picks sentences in their order, each from the text", () => {
    const s = extractiveSummary(EN, 3);
    expect(s).toHaveLength(3);
    expect(s.every((x) => EN.includes(x))).toBe(true);
    expect(s.map((x) => EN.indexOf(x))).toEqual([...s.map((x) => EN.indexOf(x))].sort((a, b) => a - b));
  });

  it("grounds sentences with quoteContained: a cut marked … still counts, an invented one doesn't", () => {
    const g = ground(["Members agreed that the building needs … reading room.", "The mayor resigned."], EN, quoteContained);
    expect(g.kept).toEqual(["Members agreed that the building needs … reading room."]);
    expect(g.dropped).toEqual(["The mayor resigned."]);
    expect(g.rate).toBe(0.5);
  });
});

describe("summarize()", () => {
  const fetchSpy = vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith("/api/tags") ? new Response(JSON.stringify({ models: [] })) : new Response("{}", { status: 404 })));
  beforeEach(() => {
    localStorage.clear();
    resetExecutors();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as { Summarizer?: unknown }).Summarizer;
  });

  const chrome = (output: string, availability = "available") => {
    const create = vi.fn(async () => ({ summarize: async () => output, destroy: () => {} }));
    (globalThis as { Summarizer?: unknown }).Summarizer = { availability: async () => availability, create };
    return create;
  };

  it("English: Chrome's Summarizer, when its model is ready and its sentences are in the text", async () => {
    chrome("- The budget for the work was set at two million.\n- Construction will start in the spring and end within a year.");
    const r = await summarize(EN);
    expect(r).toMatchObject({ engine: "chrome", grounded: 1, dropped: 0 });
    expect(r.sentences).toHaveLength(2);
  });

  it("Chrome's summary that isn't in the text is not used; nor is a model Chrome would have to download", async () => {
    chrome("- The council plans a library.\n- It costs a lot.");
    expect((await summarize(EN)).engine).toBe("extractive");
    const create = chrome("- The budget for the work was set at two million.", "downloadable");
    expect((await summarize(EN)).engine).toBe("extractive");
    expect(create).not.toHaveBeenCalled();
  });

  it("Hebrew: never Chrome's Summarizer (it has no Hebrew); the local model, with invented sentences dropped", async () => {
    const create = chrome("- something");
    const ex = fakeExecutor(sequence(["המועצה התכנסה ביום שני כדי לדון בספרייה החדשה.", "התקציב לעבודות נקבע על שני מיליון.", "הבנייה תתחיל באביב ותסתיים בתוך שנה.", "החברים הסכימו שהבניין צריך … אולם קריאה גדול יותר.", "ראש העיר התפטר."].join("\n")));
    registerExecutor(ex);
    const r = await summarize(HE);
    expect(create).not.toHaveBeenCalled();
    expect(r.engine).toBe("ollama");
    expect(r.sentences).toHaveLength(4);
    expect(r.dropped).toBe(1);
    expect(r.grounded).toBe(0.8);
    expect(r.sentences.every((s) => quoteContained(s, HE))).toBe(true);
    expect(JSON.stringify(ex.calls[0].messages)).toContain("written in Hebrew");
  });

  it("Hebrew: DictaLM in a local Ollama is the model when it is installed", async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) =>
      String(input).endsWith("/api/tags") ? new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b" }, { name: "dictalm-3.0:1.7b" }] })) : new Response("{}", { status: 404 }),
    );
    const ex = fakeExecutor(sequence("התקציב לעבודות נקבע על שני מיליון."));
    registerExecutor(ex);
    await summarize(HE);
    expect(ex.calls[0].model).toBe("dictalm-3.0:1.7b");
  });

  it("a model that keeps inventing is sent back once, then the extractive layer answers", async () => {
    const ex = fakeExecutor(sequence("The mayor resigned.\nThe library was closed."));
    registerExecutor(ex);
    const r = await summarize(EN, { noChrome: true });
    expect(ex.calls).toHaveLength(2);
    expect(JSON.stringify(ex.calls[1].messages)).toContain("not in the text");
    expect(r.engine).toBe("extractive");
    expect(r.sentences.every((s) => EN.includes(s))).toBe(true);
  });

  it("only local executors: with no local model, no request leaves — the extractive layer answers", async () => {
    localStorage.setItem("lumen.ai.policy", "cloud");
    localStorage.setItem("lumen.ai.provider", "openai");
    const r = await summarize(EN, { noChrome: true });
    expect(r.engine).toBe("extractive");
    expect(fetchSpy.mock.calls.map(([u]) => String(u)).filter((u) => !u.startsWith("http://localhost:11434"))).toEqual([]);
  });

  it("a long text is summarised in layers: each section, then the section summaries", async () => {
    const paras = Array.from({ length: 6 }, (_, i) => `Section ${i} opens with its main claim number ${i}. ` + `Detail sentence ${i} adds more words to fill the space. `.repeat(70));
    const text = paras.join("\n\n");
    const first = (i: number) => `Section ${i} opens with its main claim number ${i}.`;
    let call = 0;
    const ex = fakeExecutor(() => {
      call++;
      // Section calls: that section's opening; the final call: three of them.
      return { content: call <= sections(text).length ? first(call - 1) : [first(0), first(2), first(4)].join("\n"), toolCalls: [], model: "fake-small", usage: { inputTokens: 1, outputTokens: 1, estimated: true } };
    });
    registerExecutor(ex);
    const r = await summarize(text, { noChrome: true, sentences: 3 });
    expect(r.layers).toBe(sections(text).length);
    expect(r.layers).toBeGreaterThan(1);
    expect(ex.calls).toHaveLength(r.layers + 1);
    expect(r.sentences).toEqual([first(0), first(2), first(4)]);
    expect(r.grounded).toBe(1);
  });
});

describe("the golden summaries (7.10 summarize, dev)", () => {
  const set = JSON.parse(readFileSync(join(__dirname, "../../eval/golden/summarize/dev/sotu.json"), "utf8")) as { items: Array<{ id: string; document: string; keywords: string[] }> };
  beforeEach(() => {
    resetExecutors();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ models: [] }))));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("without a model, every sentence of the summary is in its document (quoteContained)", async () => {
    let sentences = 0;
    let grounded = 0;
    for (const item of set.items) {
      const r = await summarize(item.document, { noChrome: true, sentences: 3 });
      sentences += r.sentences.length;
      grounded += r.sentences.filter((s) => quoteContained(s, item.document)).length;
    }
    expect(sentences).toBeGreaterThan(0);
    expect(grounded / sentences).toBe(1);
  });
});
