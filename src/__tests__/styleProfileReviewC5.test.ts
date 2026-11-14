import { describe, it, expect } from "vitest";
import { proseOfNote } from "../ai/styleProfiles";

describe("proseOfNote (C5 review)", () => {
  it("drops tilde and backtick fences, tables with and without outer pipes, frontmatter and image lines", () => {
    const note = [
      "---",
      "tags: [x]",
      "---",
      "First real sentence.",
      "",
      "~~~python",
      "print('code')",
      "~~~",
      "",
      "a | b",
      "--- | ---",
      "1 | 2",
      "3 | 4",
      "",
      "| c | d |",
      "|:---|---:|",
      "| 5 | 6 |",
      "",
      "````md",
      "```",
      "nested",
      "```",
      "````",
      "![img](x.png)",
      "Second real sentence | with a pipe in prose.",
    ].join("\n");
    const prose = proseOfNote(note);
    expect(prose).toContain("First real sentence.");
    expect(prose).toContain("Second real sentence | with a pipe in prose.");
    for (const gone of ["print(", "1 | 2", "3 | 4", "| 5 |", "nested", "img", "tags:"]) expect(prose).not.toContain(gone);
  });
});
