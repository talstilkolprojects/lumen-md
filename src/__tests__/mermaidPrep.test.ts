/**
 * Plan W2.18 — Mermaid for the canvas, the pure part: cleaning pasted text
 * and model answers, the diagram type, the precheck, and the labels a
 * converted diagram must show (counted on the 20 golden diagrams).
 */
import { describe, it, expect } from "vitest";
import { diagramKind, expectedLabels, extractMermaid, missingLabels, precheck } from "../canvas/mermaidPrep";
import { MERMAID_GOLDEN } from "./fixtures/mermaidGolden";

describe("extracting Mermaid (W2.18)", () => {
  it("takes the fenced diagram out of a model's answer, or the text from its header", () => {
    expect(extractMermaid("הנה התרשים:\n```mermaid\nflowchart TD\n  A --> B\n```\nבהצלחה!")).toBe("flowchart TD\n  A --> B");
    expect(extractMermaid("Sure! Here it is.\nflowchart LR\n  A --> B")).toBe("flowchart LR\n  A --> B");
    expect(extractMermaid("```\nsequenceDiagram\n  A->>B: hi\n```")).toBe("sequenceDiagram\n  A->>B: hi");
    expect(extractMermaid("flowchart TD\n  A[“שלום”] → B\n\nThis diagram shows the flow.")).toBe('flowchart TD\n  A["שלום"] --> B');
    expect(extractMermaid("---\ntitle: x\n---\nflowchart TD\n  A --> B")).toBe("---\ntitle: x\n---\nflowchart TD\n  A --> B");
  });

  it("knows the type, and which types become editable shapes", () => {
    expect(diagramKind("%% comment\ngraph LR\nA-->B")).toBe("flowchart");
    expect(diagramKind("stateDiagram\n[*] --> A")).toBe("state");
    expect(diagramKind("mindmap\n  root")).toBe("other");
    expect(diagramKind("hello")).toBeNull();
    expect(precheck("")).toEqual({ ok: false, reason: "empty" });
    expect(precheck("not a diagram")).toEqual({ ok: false, reason: "unknown" });
    expect(precheck("gantt\n  title x")).toEqual({ ok: false, reason: "not-editable", kind: "gantt" });
    expect(precheck("erDiagram\n  A ||--o{ B : x")).toEqual({ ok: true, kind: "er" });
  });
});

describe("labels the conversion must keep (W2.18)", () => {
  it("20 golden diagrams, 4 per editable type", () => {
    expect(MERMAID_GOLDEN).toHaveLength(20);
    const kinds = MERMAID_GOLDEN.map((g) => diagramKind(g.code));
    for (const k of ["flowchart", "sequence", "class", "state", "er"]) expect(kinds.filter((x) => x === k)).toHaveLength(4);
  });

  for (const g of MERMAID_GOLDEN) {
    it(`${g.id}: ${g.nodes} node and ${g.edges} edge labels`, () => {
      const l = expectedLabels(g.code);
      expect([l.nodes.length, l.edges.length], JSON.stringify(l)).toEqual([g.nodes, g.edges]);
    });
  }

  it("the Hebrew labels are read whole", () => {
    expect(expectedLabels(MERMAID_GOLDEN[1].code)).toEqual({ nodes: ["בקשה חדשה", "האם מאושר?", "שליחה ללקוח", "ארכיון"], edges: ["כן", "לא"] });
    expect(expectedLabels(MERMAID_GOLDEN[4].code)).toEqual({ nodes: ["משתמש", "שרת"], edges: ["בקשת התחברות", "אסימון"] });
    expect(expectedLabels(MERMAID_GOLDEN[16].code)).toEqual({ nodes: ["לקוח", "הזמנה"], edges: ["מבצע"] });
  });

  it("missing labels are reported, whitespace aside", () => {
    const l = { nodes: ["בקשה חדשה", "סוף"], edges: ["כן"] };
    expect(missingLabels(l, ["בקשה\nחדשה", "כן"])).toEqual(["סוף"]);
    expect(missingLabels(l, ["בקשה חדשה", "סוף", "כן"])).toEqual([]);
  });
});
