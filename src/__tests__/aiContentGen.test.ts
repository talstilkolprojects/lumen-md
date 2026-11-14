/**
 * Tests for the AI content-generation helpers (diagram / action items /
 * translate). The LLM is mocked, so we verify prompt routing and output
 * shaping deterministically — no network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../ai/llm", () => ({
  chat: vi.fn(),
  chatStream: vi.fn(),
  getActiveProvider: () => "ollama",
  effectiveModel: () => "mock",
}));
vi.mock("../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: () => true, aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));

const mermaidParse = vi.fn(async (code: string) => {
  if (!/^(flowchart|graph|sequenceDiagram|mindmap)/.test(code)) throw new Error("Parse error on line 1: unknown diagram");
  return { diagramType: "flowchart-v2" };
});
vi.mock("mermaid", () => ({ default: { parse: (c: string) => mermaidParse(c) } }));

import { chat } from "../ai/llm";
import { registerExecutor, resetExecutors } from "../agents/executors";
import { fakeExecutor, reply, sequence } from "./helpers/fakeExecutor";
import {
  stripCodeFences,
  generateDiagram,
  extractActionItems,
  translateMarkdown,
  generateChart,
} from "../agents/commands";

const mockChat = vi.mocked(chat);

beforeEach(() => {
  mockChat.mockReset();
  resetExecutors();
  localStorage.setItem("lumen.ai.cache", "off");
});

describe("stripCodeFences", () => {
  it("removes a surrounding fenced block", () => {
    expect(stripCodeFences("```mermaid\nflowchart TD\nA-->B\n```")).toBe("flowchart TD\nA-->B");
  });
  it("leaves bare text untouched", () => {
    expect(stripCodeFences("flowchart TD\nA-->B")).toBe("flowchart TD\nA-->B");
  });
});

describe("generateDiagram (diagrammer agent)", () => {
  it("wraps the model output in a ```mermaid block, stripping model fences", async () => {
    registerExecutor(fakeExecutor(sequence("```mermaid\nflowchart TD\nA-->B\n```")));
    const out = await generateDiagram("A leads to B");
    expect(out).toBe("```mermaid\nflowchart TD\nA-->B\n```");
  });
  it("compiles the diagram and feeds a parse error back for the retry", async () => {
    const ex = fakeExecutor(sequence("not a diagram at all", "graph TD\nX-->Y"));
    registerExecutor(ex);
    expect(await generateDiagram("x then y")).toBe("```mermaid\ngraph TD\nX-->Y\n```");
    expect(ex.calls).toHaveLength(2);
    expect(ex.calls[1].messages[1].content).toContain("Parse error on line 1");
    expect(ex.calls[1].temperature).toBe(0);
  });
});

describe("extractActionItems (tasker agent)", () => {
  it("returns the task list from the model, stripping fences", async () => {
    registerExecutor(fakeExecutor(sequence("```markdown\n- [ ] Ship it (Bob)\n- [ ] Review (Ann)\n```")));
    const out = await extractActionItems("notes...");
    expect(out).toBe("- [ ] Ship it (Bob)\n- [ ] Review (Ann)");
  });

  it("retries when the answer is not a task list, feeding the reason back", async () => {
    const ex = fakeExecutor(sequence("Here are the items: ship it, review.", "- [ ] Ship it (Bob)"));
    registerExecutor(ex);
    expect(await extractActionItems("notes...")).toBe("- [ ] Ship it (Bob)");
    expect(ex.calls).toHaveLength(2);
    expect(ex.calls[1].messages[1].content).toContain("not a \"- [ ]\" task line");
  });
});

describe("translateMarkdown (translator agent)", () => {
  it("passes the target language and returns the translation", async () => {
    const ex = fakeExecutor(sequence("# Hola\n\nMundo"));
    registerExecutor(ex);
    const out = await translateMarkdown("# Hello\n\nWorld", "Spanish");
    expect(out).toBe("# Hola\n\nMundo");
    expect(ex.calls[0].messages[0].content).toContain("into Spanish");
  });
  it("rejects an answer that is not in the target script, then accepts the Hebrew one", async () => {
    const ex = fakeExecutor(sequence("# Hello\n\nWorld again", "# שלום\n\nעולם"));
    registerExecutor(ex);
    expect(await translateMarkdown("# Hello\n\nWorld", "עברית")).toBe("# שלום\n\nעולם");
    expect(ex.calls[1].messages[1].content).toContain("not written in עברית");
  });
  it("keeps code fences and URLs: a translation that drops them is retried", async () => {
    const src = "See [docs](https://x.y/a).\n\n```js\nlet a = 1;\n```";
    const ex = fakeExecutor(sequence("Ver [docs](https://x.y/b).\n\nlet a = 1;", "Ver [docs](https://x.y/a).\n\n```js\nlet a = 1;\n```"));
    registerExecutor(ex);
    expect(await translateMarkdown(src, "es")).toBe("Ver [docs](https://x.y/a).\n\n```js\nlet a = 1;\n```");
    expect(ex.calls[1].messages[1].content).toMatch(/code fences changed|URLs changed/);
  });
  it("translates long documents chunk by chunk without splitting a fence", async () => {
    const para = "Paragraph text that is long enough to matter. ".repeat(40);
    const src = `${para}\n\n\`\`\`\ncode block\n${"x\n".repeat(60)}\`\`\`\n\n${para}\n\n${para}`;
    const ex = fakeExecutor((req) => reply("T: " + req.messages[1].content));
    registerExecutor(ex);
    const out = await translateMarkdown(src, "French");
    expect(ex.calls.length).toBeGreaterThan(1);
    for (const c of ex.calls) {
      const body = c.messages[1].content;
      // No chunk has an odd number of fence lines.
      expect(((body.match(/^```/gm) ?? []).length) % 2).toBe(0);
    }
    expect(out.startsWith("T: ")).toBe(true);
  });
});

describe("generateChart (charter agent)", () => {
  it("wraps a validated ECharts option in a ```chart block", async () => {
    registerExecutor(fakeExecutor(sequence('```json\n{"xAxis":{},"yAxis":{},"series":[{"type":"bar","data":[1,2]}]}\n```')));
    const out = await generateChart("a,b\n1,2");
    expect(out.startsWith("```chart\n")).toBe(true);
    expect(JSON.parse(out.replace(/^```chart\n|\n```$/g, ""))).toEqual({ xAxis: {}, yAxis: {}, series: [{ type: "bar", data: [1, 2] }] });
  });
  it("retries a structurally invalid option with the reason", async () => {
    const ex = fakeExecutor(sequence('{"series":[{"type":"bar","data":[1]}]}', '{"series":[{"type":"pie","data":[1]}]}'));
    registerExecutor(ex);
    expect(await generateChart("a\n1")).toContain('"type": "pie"');
    expect(ex.calls[1].messages[1].content).toContain("xAxis");
  });
});
