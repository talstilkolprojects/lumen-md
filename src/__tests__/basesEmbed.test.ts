/** `![[x.base]]` in a note and a `.base` opened in the editor (plan W1.11). */
import { describe, it, expect } from "vitest";
import type { Root } from "mdast";
import { baseAsMarkdown, parseBaseEmbedMeta, remarkBaseEmbeds } from "../views/bases/embed";

const para = (value: string) => ({ type: "paragraph", children: [{ type: "text", value }] });

describe("Bases embeds (W1.11)", () => {
  it("a paragraph that is only ![[x.base]] becomes a base block naming the file and view", () => {
    const tree = { type: "root", children: [para("![[Books.base]]"), para("![[Reading list.base#Top two]]"), para("see ![[Books.base]] inline"), para("![[photo.png]]")] };
    remarkBaseEmbeds()(tree as unknown as Root);
    const kids = tree.children as Array<{ type: string; lang?: string; meta?: string }>;
    expect(kids.map((k) => k.type)).toEqual(["code", "code", "paragraph", "paragraph"]);
    expect(kids[0].lang).toBe("base");
    expect(parseBaseEmbedMeta(kids[0].meta)).toEqual({ path: "Books.base", view: undefined });
    expect(parseBaseEmbedMeta(kids[1].meta)).toEqual({ path: "Reading list.base", view: "Top two" });
  });

  it("an inline ```base block has no embed meta", () => {
    expect(parseBaseEmbedMeta("")).toBeNull();
    expect(parseBaseEmbedMeta("title=x")).toBeNull();
    expect(parseBaseEmbedMeta(undefined)).toBeNull();
  });

  it("a .base file previews as one base block, fenced past any backticks inside", () => {
    expect(baseAsMarkdown("views:\n  - type: table\n")).toBe("```base\nviews:\n  - type: table\n```\n");
    const tricky = 'formulas:\n  x: \'"````"\'\n';
    expect(baseAsMarkdown(tricky).startsWith("`````base\n")).toBe(true);
  });
});
