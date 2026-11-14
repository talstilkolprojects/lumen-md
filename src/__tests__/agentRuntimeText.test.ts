/**
 * src/agents/runtimeText.ts (W6.25: moved out of agents/runtime.ts): how a
 * long input is split into parts and how the parts' answers are merged.
 * The agent tests reach these only through runAgent's `split` option, so
 * the mutation run (scripts/mutation/targets.json) lists this file too.
 */
import { describe, expect, it } from "vitest";
import { mergeOutputs, splitText } from "../agents/runtimeText";

describe("splitText", () => {
  it("joins blank-line blocks up to the limit, one line apart", () => {
    expect(splitText("a\n\nb\n\nc", 3)).toEqual(["a\nb", "c"]);
    expect(splitText("aa\n\nbb\n\ncc", 100)).toEqual(["aa\nbb\ncc"]);
    expect(splitText("aaaa\n\nbbbb", 5)).toEqual(["aaaa", "bbbb"]);
    // A block keeps its own inner blank lines; only the trailing ones go.
    expect(splitText("ab\n\n\n\ncd", 10)).toEqual(["ab\n\n\ncd"]);
  });

  it("does not end a block inside a fenced code block (``` or ~~~)", () => {
    expect(splitText("```\nx\n\ny\n```\n\nz", 8)).toEqual(["```\nx\n\n", "y\n```\nz"]);
    expect(splitText("~~~\na\n\nb\n~~~", 3)).toEqual(["~~~", "a\n\n", "b\n", "~~~"]);
  });

  it("cuts a block longer than a part at sentence ends, and a sentence longer than a part hard", () => {
    expect(splitText("One. Two. Three.", 6)).toEqual(["One. ", "Two. ", "Three."]);
    expect(splitText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(splitText("x. yyyyyyyyyy", 4)).toEqual(["x. ", "yyyy", "yyyy", "yy"]);
    for (const p of splitText("One. Two. Three. ".repeat(20), 30)) expect(p.length).toBeLessThanOrEqual(30);
  });

  it("gives no empty parts", () => {
    expect(splitText("", 4)).toEqual([]);
    expect(splitText("\n\n\n", 4)).toEqual([]);
  });
});

describe("mergeOutputs", () => {
  it("joins text answers by a blank line, trimmed", () => {
    expect(mergeOutputs(["a ", " b"])).toBe("a\n\nb");
  });

  it("merges objects: lists concatenated (plain values without repeats), the first value of anything else", () => {
    expect(mergeOutputs([{ tags: ["x", "y"], title: "A" }, { tags: ["y", "z"], title: "B", n: 1 }])).toEqual({ tags: ["x", "y", "z"], title: "A", n: 1 });
    expect(mergeOutputs([{ items: [{ a: 1 }] }, { items: [{ a: 1 }] }])).toEqual({ items: [{ a: 1 }, { a: 1 }] });
    // A list in a later part takes the place of a value that was not a list.
    expect(mergeOutputs([{ items: "x" }, { items: ["y"] }])).toEqual({ items: ["y"] });
  });

  it("flattens lists, and otherwise keeps the first answer", () => {
    expect(mergeOutputs([[1, 2], [3]])).toEqual([1, 2, 3]);
    expect(mergeOutputs([1, 2])).toBe(1);
    expect(mergeOutputs(["only"])).toBe("only");
    expect(mergeOutputs([])).toBeUndefined();
    expect(mergeOutputs([{ a: 1 }, "s"] as unknown[])).toEqual({ a: 1 });
    expect(mergeOutputs([null, { a: 1 }] as unknown[])).toBe(null);
  });
});
