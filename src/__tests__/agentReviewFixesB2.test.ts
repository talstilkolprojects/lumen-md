import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => ({ aiKey: null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null }) } }));
vi.mock("../store/useToastStore", () => ({ toast: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));

import { registerExecutor, resetExecutors } from "../agents/executors";
import { chunkMarkdown, checkTranslation, fencedBlocks, urlsOf } from "../agents/defs";
import { translateMarkdown } from "../agents/commands";
import { fakeExecutor } from "./helpers/fakeExecutor";

beforeEach(() => {
  resetExecutors();
  localStorage.setItem("lumen.ai.cache", "off");
});

describe("translator review fixes", () => {
  it("bounds chunks with no blank line (a long table) at a line boundary, outside fences, and stays lossless", () => {
    const table = ["| a | b |", "|---|---|", ...Array.from({ length: 200 }, (_, i) => `| row ${i} | value ${i} |`)].join("\n");
    const chunks = chunkMarkdown(table, 500);
    expect(chunks.length).toBeGreaterThan(5);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(500 * 1.25 + 30);
    expect(chunks.join("\n")).toBe(table);
    const fenced = "```\n" + "x\n".repeat(400) + "```";
    expect(chunkMarkdown(fenced, 100)).toEqual([fenced]);
  });

  it("restores the paragraph break between chunks", async () => {
    const doc = "Paragraph one is here.\n\nParagraph two is here.";
    let n = 0;
    registerExecutor(fakeExecutor((req) => ({ content: `תרגום ${++n} ${req.messages[1].content.length > 0 ? "מוכן" : ""}`, toolCalls: [], model: "m" })));
    const out = await translateMarkdown(doc, "Hebrew");
    // CHUNK_CHARS is far larger here: one chunk. Force two with a long doc.
    expect(out).toContain("תרגום");
    const long = "א".repeat(10) + "\n\n" + Array.from({ length: 3 }, (_, i) => `Para ${i} ` + "w ".repeat(1800)).join("\n\n");
    n = 0;
    const out2 = await translateMarkdown(long, "Hebrew");
    expect(out2.split("\n\n").length).toBeGreaterThanOrEqual(2);
    expect(out2).not.toMatch(/מוכן\nתרגום/);
  });

  it("rejects rewritten code inside fences and changed URLs in every link form", () => {
    const src = "Text\n\n```js\nconst a = 1; // set\n```\n\n[docs][d] and <https://auto.example> and https://bare.example/x.\n\n[d]: https://good.example";
    const good = "טקסט\n\n```js\nconst a = 1; // set\n```\n\n[מסמכים][d] וגם <https://auto.example> וגם https://bare.example/x.\n\n[d]: https://good.example";
    expect(checkTranslation(good, src, "Hebrew").ok).toBe(true);
    expect(checkTranslation(good.replace("// set", "// קבע"), src, "Hebrew")).toMatchObject({ ok: false, reason: "code inside a fenced block changed" });
    expect(checkTranslation(good.replace("https://good.example", "https://evil.example"), src, "Hebrew")).toMatchObject({ ok: false, reason: "link or image URLs changed" });
    expect(checkTranslation(good.replace("<https://auto.example>", "<https://evil.example>"), src, "Hebrew").ok).toBe(false);
    expect(checkTranslation(good.replace("https://bare.example/x", "https://evil.example/x"), src, "Hebrew").ok).toBe(false);
    expect(urlsOf("[a](https://x.example/p) https://y.example.")).toEqual(["https://x.example/p", "https://y.example"]);
    expect(fencedBlocks("~~~\na  \n~~~\n```\nb\n```")).toEqual(["a", "b"]);
  });
});
