/**
 * Source-preserving save (W1.2): the block mapping that lets the WYSIWYG
 * editor write unedited blocks back exactly as the file had them, and the
 * line-ending choice both editors share. Milkdown's serializer is
 * remark-stringify, so mdast-util-to-markdown stands in for it here; the real
 * editor runs in mdRoundTrip.test.ts.
 */
import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { toMarkdown } from "mdast-util-to-markdown";
import type { Root } from "mdast";
import { blocksFromMdast, createSourcePreserver } from "../editor/sourcePreserve";
import { lineSeparatorFor } from "../editor/lineEndings";

const parser = unified().use(remarkParse);
const parse = (md: string) => parser.parse(md) as Root;
const split = blocksFromMdast((md) => parse(md) as never);
const serialize = (md: string) => toMarkdown(parse(md));

describe("lineSeparatorFor", () => {
  it("keeps the file's own line ending", () => {
    expect(lineSeparatorFor("a\r\nb\r\n")).toBe("\r\n");
    expect(lineSeparatorFor("a\rb\r")).toBe("\r");
    expect(lineSeparatorFor("a\nb\n")).toBe("\n");
    expect(lineSeparatorFor("")).toBe("\n");
    expect(lineSeparatorFor("one line")).toBe("\n");
  });

  it("uses \\n for mixed endings, so the stray \\r stays in the text", () => {
    expect(lineSeparatorFor("a\r\nb\n")).toBe("\n");
    expect(lineSeparatorFor("a\rb\n")).toBe("\n");
  });
});

describe("createSourcePreserver", () => {
  it("writes an unedited document back byte for byte, however the serializer rewrites it", () => {
    const O = "Title\n=====\n\n__bold__ text\n\n+ a\n+ b\n\n***\n\n| a |b|\n|-|-|\n|1|2|\n";
    const C = serialize(O);
    expect(C).not.toBe(O);
    expect(createSourcePreserver(O, C, split).restore(C)).toBe(O);
  });

  it("rewrites only the block that was edited", () => {
    const O = "Title\n=====\n\n__bold__ text\n\n+ a\n+ b\n\n***\n";
    const p = createSourcePreserver(O, serialize(O), split);
    const tree = parse(O);
    const para = tree.children[1] as { children: { value?: string }[] };
    para.children[1].value = " text!";
    expect(p.restore(toMarkdown(tree))).toBe("Title\n=====\n\n**bold** text!\n\n+ a\n+ b\n\n***\n");
  });

  it("keeps blocks the editor never showed, and gives new blocks the file's CRLF", () => {
    const O = "Intro *x*\r\n\r\n[ref]: http://a.example\r\n\r\n* one\r\n* two\r\n";
    const C = "Intro *x*\n\n* one\n* two\n"; // the serializer dropped the definition
    const p = createSourcePreserver(O, C, split);
    expect(p.restore(C)).toBe(O);
    expect(p.restore("Intro *x*\n\nNew para\n\n* one\n* two\n")).toBe(
      "Intro *x*\r\n\r\nNew para\r\n\r\n[ref]: http://a.example\r\n\r\n* one\r\n* two\r\n",
    );
    expect(p.restore("Intro *y*\n\n* one\n* two\n")).toBe(
      "Intro *y*\r\n\r\n[ref]: http://a.example\r\n\r\n* one\r\n* two\r\n",
    );
  });

  it("never writes a block twice when the editor showed it in a changed form", () => {
    const O = "<div>raw</div>\n\npara\n";
    const C = "raw\n\npara\n"; // shown, but not as the same block
    const p = createSourcePreserver(O, C, split);
    expect(p.restore(C)).toBe("raw\n\npara\n");
    expect(p.restore("raw\n\npara!\n")).toBe("raw\n\npara!\n");
  });

  it("handles deleted, moved and added blocks", () => {
    const O = "# A\n\npara one\n\n- x\n- y\n\npara two\n";
    const C = serialize(O);
    const p = createSourcePreserver(O, C, split);
    // Delete the list.
    expect(p.restore("# A\n\npara one\n\npara two\n")).toBe("# A\n\npara one\n\npara two\n");
    // Add a block at the end.
    expect(p.restore(C + "\nnew\n")).toBe(O + "\nnew\n");
    // Empty document.
    expect(p.restore("")).toBe("");
  });

  it("keeps Hebrew text and right-to-left marks untouched", () => {
    const O = "# כותרת\n\n__מודגש__ ‏טקסט‏\n\n* פריט\n";
    const C = serialize(O);
    expect(createSourcePreserver(O, C, split).restore(C)).toBe(O);
  });

  it("passes through when the original is empty", () => {
    expect(createSourcePreserver("", "", split).restore("new\n")).toBe("new\n");
  });
});
