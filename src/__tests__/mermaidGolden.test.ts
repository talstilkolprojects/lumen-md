/**
 * Plan W2.18 — the 20 golden diagrams are valid Mermaid for the real parser
 * (the validator the "draw me" answers go through), Hebrew labels included,
 * and a broken one is refused with the parser's message. Needs a browser
 * (Mermaid uses the DOM).
 */
import { describe, it, expect } from "vitest";
import { checkMermaid } from "../agents/tools/validate";
import { MERMAID_GOLDEN } from "./fixtures/mermaidGolden";

describe("golden diagrams parse (W2.18)", () => {
  for (const g of MERMAID_GOLDEN) {
    it(g.id, async () => {
      const r = await checkMermaid(g.code);
      expect(r.error ?? "ok").toBe("ok");
    });
  }

  it("refuses a broken diagram with the parser's error", async () => {
    const r = await checkMermaid("flowchart TD\n  A[שלום --> B");
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
