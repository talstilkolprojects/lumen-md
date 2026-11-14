/**
 * Obsidian syntax (W1.3) on the syntax tree: callouts, %%comments%%,
 * ==highlights== with colour, image embeds and sizes, and the width
 * write-back used by drag-to-resize.
 */
import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import type { Root } from "mdast";
import { remarkObsidian } from "../renderer/remarkObsidian";
import { setImageWidth } from "../renderer/imageSize";

/* eslint-disable @typescript-eslint/no-explicit-any -- inspecting built mdast */
function tree(md: string, opts = {}): any {
  const p = unified().use(remarkParse).use(remarkObsidian, opts);
  return p.runSync(p.parse(md) as Root) as any;
}

/** Plain text of a subtree, ignoring structure. */
function text(n: any): string {
  if (typeof n.value === "string") return n.value;
  return (n.children ?? []).map(text).join("");
}

function find(n: any, pred: (x: any) => boolean, out: any[] = []): any[] {
  if (pred(n)) out.push(n);
  for (const c of n.children ?? []) find(c, pred, out);
  return out;
}

describe("callouts", () => {
  it("turns > [!type] into a callout with its title and body", () => {
    const t = tree("> [!warning] Mind the gap\n> Body text\n>\n> More\n");
    const q = t.children[0];
    expect(q.data.hName).toBe("div");
    expect(q.data.hProperties.className).toEqual(["callout", "callout-warning"]);
    expect(q.data.hProperties["data-callout"]).toBe("warning");
    expect(text(q.children[0])).toBe("Mind the gap");
    expect(q.children[0].data.hProperties.className).toEqual(["callout-title"]);
    expect(q.children[1].data.hProperties.className).toEqual(["callout-content"]);
    expect(text(q.children[1])).toContain("Body text");
    expect(text(q.children[1])).toContain("More");
  });

  it("folds with + (open) and - (closed) as details/summary", () => {
    const open = tree("> [!tip]+ Open\n> x\n").children[0];
    expect(open.data.hName).toBe("details");
    expect(open.data.hProperties.open).toBe(true);
    expect(open.children[0].data.hName).toBe("summary");
    const closed = tree("> [!faq]- Closed\n> x\n").children[0];
    expect(closed.data.hProperties.open).toBe(false);
    expect(closed.data.hProperties.className).toEqual(["callout", "callout-question"]);
    expect(closed.data.hProperties["data-callout"]).toBe("faq");
  });

  it("uses the translated default title, and the type itself for unknown types", () => {
    const titles: string[] = [];
    const t = tree("> [!note]\n> x\n\n> [!custom-thing]\n> y\n", {
      calloutTitle: (kind: string, type: string) => {
        titles.push(`${kind}/${type}`);
        return kind === "note" && type === "note" ? "הערה" : "Custom-thing";
      },
    });
    expect(text(t.children[0].children[0])).toBe("הערה");
    expect(text(t.children[1].children[0])).toBe("Custom-thing");
    expect(t.children[1].data.hProperties.className).toEqual(["callout", "callout-note"]);
    expect(titles).toEqual(["note/note", "note/custom-thing"]);
  });

  it("keeps formatting in the title and works in Hebrew and when nested", () => {
    const t = tree("> [!info] **חשוב** מאוד\n> גוף\n> > [!bug] Inner\n> > text\n");
    const outer = t.children[0];
    expect(find(outer.children[0], (n) => n.type === "strong").length).toBe(1);
    expect(text(outer.children[0])).toBe("חשוב מאוד");
    const inner = find(outer, (n) => n.data?.hProperties?.["data-callout"] === "bug");
    expect(inner.length).toBe(1);
  });

  it("leaves ordinary quotes and [!x] later in a quote alone", () => {
    const t = tree("> plain quote\n\n> text [!note] later\n");
    expect(t.children[0].data).toBe(undefined);
    expect(t.children[1].data).toBe(undefined);
  });

  it("can keep callouts as quotes (WYSIWYG)", () => {
    expect(tree("> [!note] x\n", { callouts: false }).children[0].data).toBe(undefined);
  });
});

describe("%%comments%%", () => {
  it("hides inline comments", () => {
    expect(text(tree("before %%secret%% after\n"))).toBe("before  after");
  });

  it("hides comments across blocks, and across inline formatting", () => {
    const t = tree("one\n\n%%\nhidden *para*\n\n- hidden list\n%%\n\ntwo %%a **b** c%% end\n");
    expect(text(t)).toBe("onetwo  end");
    expect(find(t, (n) => n.type === "list").length).toBe(0);
  });

  it("an unclosed comment hides the rest of the note", () => {
    expect(text(tree("shown\n\n%% start\n\nhidden\n"))).toBe("shown");
  });

  it("never touches code", () => {
    const t = tree("`%%code%%`\n\n```\n%% fenced %%\n```\n");
    expect(find(t, (n) => n.type === "inlineCode")[0].value).toBe("%%code%%");
    expect(find(t, (n) => n.type === "code")[0].value).toBe("%% fenced %%");
  });

  it("can keep comments (WYSIWYG shows them)", () => {
    expect(text(tree("a %%b%% c\n", { keepComments: true }))).toBe("a %%b%% c");
  });
});

describe("==highlights==", () => {
  it("wraps a highlight in a mark", () => {
    const h = find(tree("a ==marked== b\n"), (n) => n.type === "highlight");
    expect(h.length).toBe(1);
    expect(text(h[0])).toBe("marked");
    expect(h[0].data.hName).toBe("mark");
    expect(h[0].data.hProperties.className).toEqual(["obsidian-highlight"]);
  });

  it("takes the colour from a leading emoji (Obsidian 1.14) and removes it", () => {
    const h = find(tree("==🔴urgent== and ==🔵 calm==\n"), (n) => n.type === "highlight");
    expect(h.map((x) => x.color)).toEqual(["red", "blue"]);
    expect(h.map(text)).toEqual(["urgent", " calm"]);
    expect(h[0].data.hProperties.className).toEqual(["obsidian-highlight", "hl-red"]);
    // The emoji with its presentation selector (U+FE0F) is removed whole.
    const vs = find(tree(`==🟢${String.fromCharCode(0xfe0f)}ok==\n`), (n) => n.type === "highlight");
    expect(vs.map(text)).toEqual(["ok"]);
  });

  it("spans inline formatting and works in Hebrew", () => {
    const h = find(tree("==🟢 טקסט **מודגש** כאן==\n"), (n) => n.type === "highlight");
    expect(h.length).toBe(1);
    expect(find(h[0], (n) => n.type === "strong").length).toBe(1);
  });

  it("needs non-space inside the markers, and ignores === and code", () => {
    expect(find(tree("a == b == c\n"), (n) => n.type === "highlight").length).toBe(0);
    expect(find(tree("x === y\n"), (n) => n.type === "highlight").length).toBe(0);
    expect(find(tree("`==no==`\n"), (n) => n.type === "highlight").length).toBe(0);
    expect(text(tree("a ==open only\n"))).toBe("a ==open only");
  });
});

describe("image embeds and sizes", () => {
  it("embeds ![[img.png]] with width, width x height, and alt text", () => {
    const imgs = find(tree("![[a.png]] ![[pics/b c.jpg|300]] ![[d.webp|120x80]] ![[e.gif|A cat|200]]\n"), (n) => n.type === "image");
    expect(imgs.map((i) => i.url)).toEqual(["a.png", "pics/b%20c.jpg", "d.webp", "e.gif"]);
    expect(imgs.map((i) => i.data.hProperties.width)).toEqual([undefined, 300, 120, 200]);
    expect(imgs[2].data.hProperties.height).toBe(80);
    expect(imgs[3].alt).toBe("A cat");
    expect(imgs[1].alt).toBe("b c");
    expect(imgs[1].data.hProperties["data-md-offset"]).toBe(11);
    expect(imgs[1].data.hProperties["data-md-target"]).toBe("pics/b c.jpg");
  });

  it("sizes Markdown images written ![alt|300](src)", () => {
    const img = find(tree("![A dog|250x100](dog.png)\n"), (n) => n.type === "image")[0];
    expect(img.alt).toBe("A dog");
    expect(img.data.hProperties.width).toBe(250);
    expect(img.data.hProperties.height).toBe(100);
    expect(img.data.hProperties["data-md-offset"]).toBe(0);
  });

  it("leaves note embeds (![[Note]]) to the wiki links", () => {
    expect(find(tree("![[Some note]]\n"), (n) => n.type === "image").length).toBe(0);
  });
});

describe("setImageWidth (drag to resize)", () => {
  it("writes the width into the embed or the Markdown image at the offset", () => {
    expect(setImageWidth("x ![[a.png]] y", 2, 300)).toBe("x ![[a.png|300]] y");
    expect(setImageWidth("![[a.png|100x50]]", 0, 240.4)).toBe("![[a.png|240]]");
    expect(setImageWidth("![[a.png|A cat|100]]", 0, 90)).toBe("![[a.png|A cat|90]]");
    expect(setImageWidth("![dog](d.png)", 0, 320)).toBe("![dog|320](d.png)");
    expect(setImageWidth("![dog|10](d.png)", 0, 320)).toBe("![dog|320](d.png)");
  });

  it("finds the image by its target when the note moved on, and otherwise changes nothing", () => {
    const md = "new line\n\n![[a.png]]";
    expect(setImageWidth(md, 0, 200, "a.png")).toBe("new line\n\n![[a.png|200]]");
    expect(setImageWidth("no images", 3, 200, "a.png")).toBe("no images");
    expect(setImageWidth("text", 1, 200)).toBe("text");
  });
});
