/** T29 — reranking and verified citations for "Ask the vault". */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { lexicalScore, rerank, setRerankMode } from "../ai/reranker";
import { lineOfQuote, parseVaultCitations, verifyVaultCitations } from "../ai/vaultCitations";

vi.mock("../ai/transformersEngine", () => ({
  rerankLocal: vi.fn(async (_q: string, passages: string[]) => passages.map((p) => (p.includes("BEST") ? 0.99 : 0.1))),
}));

const notes = [
  { path: "meetings/2026-10.md", content: "# Weekly\n\nThe launch moved to Tuesday after the review.\nBudget stays the same.\n" },
  { path: "פרויקטים/השקה.md", content: "# השקה\n\nההשקה נדחתה ליום שלישי בגלל הבדיקות.\nהתקציב לא השתנה.\n" },
];

describe("reranker", () => {
  beforeEach(() => localStorage.clear());

  it("lexical score is Hebrew-aware (prefixes, niqqud)", () => {
    expect(lexicalScore("השקה שלישי", "וההשקה נדחתה ליום שלישי")).toBe(1);
    expect(lexicalScore("launch budget", "nothing related")).toBe(0);
  });

  it("lexical mode puts the passage that covers the question first", async () => {
    const out = await rerank("when is the launch", [
      { id: "a", text: "budget notes" },
      { id: "b", text: "the launch is on Tuesday" },
    ]);
    expect(out[0].id).toBe("b");
  });

  it("model mode uses the local cross-encoder", async () => {
    setRerankMode("model");
    const out = await rerank("q", [{ id: "a", text: "meh" }, { id: "b", text: "BEST match" }]);
    expect(out.map((o) => o.id)).toEqual(["b", "a"]);
  });
});

describe("vault citations", () => {
  it("parses [n] with an optional quote", () => {
    expect(parseVaultCitations('Moved [1] "The launch moved to Tuesday". Also [2].')).toEqual([
      { n: 1, quote: "The launch moved to Tuesday" },
      { n: 2, quote: null },
    ]);
  });

  it("verifies quotes against the cited note and finds the line", () => {
    const answer = 'The launch moved [1] "The launch moved to Tuesday after the review". ההשקה נדחתה [2] "ההשקה נדחתה ליום שלישי". Budget doubled [1] "Budget doubled this quarter".';
    const { citations, verifiedCount } = verifyVaultCitations(answer, notes);
    expect(verifiedCount).toBe(2);
    expect(citations[0]).toMatchObject({ path: "meetings/2026-10.md", line: 3, verified: true });
    expect(citations[1]).toMatchObject({ path: "פרויקטים/השקה.md", line: 3, verified: true });
    expect(citations[2]).toMatchObject({ verified: false });
  });

  it("a quote that drops a meaning-changing word is not verified", () => {
    const src = [{ path: "a.md", content: "Alice never approved the launch today.\n" }];
    expect(verifyVaultCitations('[1] "Alice approved the launch today"', src).verifiedCount).toBe(0);
    expect(verifyVaultCitations('[1] "Alice never approved the launch"', src).verifiedCount).toBe(1);
    // Formatting, case and line breaks don't matter; an ellipsis may skip words.
    const md = [{ path: "b.md", content: "The **launch** moved\nto Tuesday, after the long review.\n" }];
    expect(verifyVaultCitations('[1] "the launch moved to Tuesday"', md).verifiedCount).toBe(1);
    expect(verifyVaultCitations('[1] "launch moved … the long review"', md).verifiedCount).toBe(1);
    expect(verifyVaultCitations('[1] "the review … launch moved"', md).verifiedCount).toBe(0);
  });

  it("an answer with no verified citation is reported as unsupported", () => {
    expect(verifyVaultCitations("It is on Friday [3].", notes).verifiedCount).toBe(0);
    expect(verifyVaultCitations("No citations at all.", notes).citations).toEqual([]);
  });

  it("lineOfQuote tolerates a quote that spans a line break", () => {
    expect(lineOfQuote("a\nThe launch moved to\nTuesday after review", "launch moved to Tuesday")).toBe(2);
  });
});
