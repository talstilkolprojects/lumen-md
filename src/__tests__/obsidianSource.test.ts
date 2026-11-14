/** W1.3 — what the source editor marks for Obsidian syntax (styling only). */
import { describe, expect, it } from "vitest";
import { obsidianSourceMarks } from "../editor/obsidianSource";

const marks = (s: string) => obsidianSourceMarks(s).map((m) => [s.slice(m.from, m.to), m.cls]);

describe("obsidianSourceMarks", () => {
  it("marks highlights in their colour, comments and callout heads", () => {
    expect(marks("> [!tip]- Title\n> ==🔴 hot== and ==plain== %%note%%\n")).toEqual([
      ["> [!tip]-", "cm-obs-callout"],
      ["==🔴 hot==", "cm-obs-highlight hl-red"],
      ["==plain==", "cm-obs-highlight"],
      ["%%note%%", "cm-obs-comment"],
    ]);
  });

  it("marks a comment across lines, and nothing inside it", () => {
    expect(marks("a %%\n==x==\n%% b")).toEqual([["%%\n==x==\n%%", "cm-obs-comment"]]);
  });

  it("does not mark `== spaced ==` or `===`", () => {
    expect(marks("a == b == c === d")).toEqual([]);
  });

  it("marks nested callout heads and Hebrew highlights", () => {
    expect(marks("> > [!note] כותרת\n==🟢 עברית==")).toEqual([
      ["> > [!note]", "cm-obs-callout"],
      ["==🟢 עברית==", "cm-obs-highlight hl-green"],
    ]);
  });
});
