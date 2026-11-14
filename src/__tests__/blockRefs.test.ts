/**
 * Block references (4.8): `^id` blocks get a DOM id in the preview (and the
 * marker is hidden); "Copy link to block" adds an id where there is none;
 * renaming or moving a note keeps `[[Note#^id]]` and `![[Note#^id]]`.
 */
import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import { toHtml } from "hast-util-to-html";
import type { Root as HastRoot } from "hast";
import { remarkBlockIds } from "../renderer/remarkBlockIds";
import { blockIdEdit, newBlockId } from "../editor/blockLink";
import { headingSlug } from "../lib/slug";
import { rewriteLinks } from "../storage/linkRewrite";

const html = (md: string) => {
  const p = unified().use(remarkParse).use(remarkGfm).use(remarkBlockIds).use(remarkRehype);
  return toHtml(p.runSync(p.parse(md)) as HastRoot);
};

describe("remarkBlockIds", () => {
  it("a paragraph ending in ^id gets the id, without the marker", () => {
    expect(html("Ship it. ^ship\n")).toBe('<p id="^ship">Ship it.</p>');
    expect(html("Line one\nline two ^two-lines\n")).toBe('<p id="^two-lines">Line one\nline two</p>');
  });

  it("a list item is the block; a ^id line of its own names the block before it", () => {
    expect(html("- first ^a\n- second\n")).toContain('<li id="^a">first</li>');
    const t = html("| a | b |\n| - | - |\n| 1 | 2 |\n\n^tbl\n");
    expect(t).toContain('<table id="^tbl">');
    expect(t).not.toContain("^tbl</p>");
    expect(html("> quoted\n\n^q\n")).toContain('<blockquote id="^q">');
  });

  it("leaves code and text that only looks like a marker", () => {
    expect(html("```\ncode ^nope\n```\n")).toContain("code ^nope");
    expect(html("a^b\n")).toBe("<p>a^b</p>");
    expect(html("2^10 is 1024\n")).toBe("<p>2^10 is 1024</p>");
  });
});

describe("blockIdEdit", () => {
  const id = () => "abc123";
  const apply = (text: string, pos: number) => {
    const e = blockIdEdit(text, pos, id);
    if (e.kind !== "block" || !e.change) return { e, text };
    return { e, text: text.slice(0, e.change.from) + e.change.insert + text.slice(e.change.from) };
  };

  it("appends ^id to the paragraph's last line, or reuses its id", () => {
    const md = "# Title\n\nFirst line\nsecond line\n\nNext.\n";
    expect(apply(md, md.indexOf("First")).text).toBe("# Title\n\nFirst line\nsecond line ^abc123\n\nNext.\n");
    const marked = "Done already ^old\n";
    expect(blockIdEdit(marked, 2, id)).toEqual({ kind: "block", id: "old", change: null });
  });

  it("list items take it on their line; tables, quotes and code on a line of their own", () => {
    expect(apply("- one\n- two\n", 8).text).toBe("- one\n- two ^abc123\n");
    expect(apply("| a |\n| - |\n| 1 |\nAfter\n", 2).text).toBe("| a |\n| - |\n| 1 |\n\n^abc123\n\nAfter\n");
    expect(apply("```js\nx()\n```\n", 7).text).toBe("```js\nx()\n```\n\n^abc123\n");
    expect(apply("> q\n", 1).text).toBe("> q\n\n^abc123\n");
    expect(blockIdEdit("> q\n\n^have\n", 1, id)).toEqual({ kind: "block", id: "have", change: null });
  });

  it("a heading gives its heading link; blank lines and front matter give nothing", () => {
    expect(blockIdEdit("## Setup\n", 3, id)).toEqual({ kind: "heading", heading: "Setup" });
    expect(blockIdEdit("a\n\nb\n", 2, id)).toEqual({ kind: "none" });
    expect(blockIdEdit("---\ntitle: x\n---\nbody\n", 6, id)).toEqual({ kind: "none" });
  });

  it("keeps CRLF lines intact", () => {
    expect(apply("Para\r\n\r\nNext\r\n", 1).text).toBe("Para ^abc123\r\n\r\nNext\r\n");
  });

  it("ids are short base36 and unique in the note", () => {
    const seq = [0.5, 0.5, 0.25];
    const taken = new Set([newBlockId(new Set(), () => 0.5)]);
    expect(newBlockId(taken, () => seq.shift()!)).toMatch(/^[0-9a-z]{6}$/);
    expect(taken.has(newBlockId(taken, () => 0.25))).toBe(false);
  });
});

describe("block references survive a rename and a move", () => {
  const note = "See [[Plans#^goal]] and ![[Plans#^goal]], [[folder/Plans#^goal|the goal]].\n";
  it("rename", () => {
    expect(rewriteLinks("See [[Plans#^goal]] and ![[Plans#^goal]] and [[Plans#^goal|the goal]].\n", "Hub.md", "Plans.md", "Roadmap.md")).toBe(
      "See [[Roadmap#^goal]] and ![[Roadmap#^goal]] and [[Roadmap#^goal|the goal]].\n",
    );
  });
  it("move into a folder, and with a path link", () => {
    expect(rewriteLinks(note, "Hub.md", "folder/Plans.md", "archive/2026/Plans.md")).toBe(
      "See [[Plans#^goal]] and ![[Plans#^goal]], [[archive/2026/Plans#^goal|the goal]].\n",
    );
    expect(rewriteLinks("[[Plans#^goal]]", "Hub.md", "Plans.md", "archive/Plans.md")).toBe("[[Plans#^goal]]");
  });
});

describe("following a block link in the preview", () => {
  it("[[#^id]] scrolls to the block of this note; [[Note#^id]] opens Note with the block id", async () => {
    const { handleWikiLinkClick } = await import("../renderer/wikiLinks");
    const root = document.createElement("div");
    root.innerHTML = '<p id="^goal">Goal</p><a class="wiki-link" data-wiki-target="#^goal" href="#goal">x</a><a class="wiki-link" data-wiki-target="Plans#^goal" href="#plansgoal">y</a>';
    const block = root.querySelector("p")!;
    let scrolled = 0;
    block.scrollIntoView = () => void scrolled++;
    const [own, other] = root.querySelectorAll("a");
    const ev = (target: Element) => ({ target, preventDefault() {} });
    expect(handleWikiLinkClick(ev(own), root, async () => [], () => {})).toBe(true);
    expect(scrolled).toBe(1);
    const opened: Array<[string, string | undefined]> = [];
    expect(handleWikiLinkClick(ev(other), root, async () => ["Plans.md"], (p, h) => opened.push([p, h]))).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(opened).toEqual([["Plans.md", "^goal"]]);
  });
});

describe("Vault Doctor and block references", () => {
  it("a link to an existing ^id is fine; to a missing one it is reported", async () => {
    const { runVaultDoctor } = await import("../lint/vaultDoctor");
    const findings = runVaultDoctor([
      { path: "Plans.md", text: "# Plans\n\nThe goal. ^goal\n" },
      { path: "Hub.md", text: "See [[Plans#^goal]], ![[Plans#^goal]] and [[Plans#^gone]].\n" },
    ]).filter((f) => f.kind === "missing-heading");
    expect(findings.map((f) => f.detail)).toEqual(["Plans#^gone"]);
  });
});

describe("review fixes (PR #238)", () => {
  const id = () => "abc123";
  const apply = (text: string, pos: number) => {
    const e = blockIdEdit(text, pos, id);
    if (e.kind !== "block" || !e.change) return text;
    return text.slice(0, e.change.from) + e.change.insert + text.slice(e.change.from);
  };

  it("a GFM table without outer pipes takes its id on a line after the table", () => {
    const md = "Intro.\n\na | b\n-- | --\n1 | 2\n3 | 4\n\nAfter.\n";
    for (const row of ["a | b", "-- | --", "3 | 4"]) expect(apply(md, md.indexOf(row) + 1)).toBe("Intro.\n\na | b\n-- | --\n1 | 2\n3 | 4\n\n^abc123\n\nAfter.\n");
    expect(html(apply(md, md.indexOf("3 | 4")))).toContain('<table id="^abc123">');
  });

  it("inside a fence that is never closed there is no block to link (W1.32, Codex P2 on #238)", () => {
    expect(blockIdEdit("Intro.\n\n```js\nx()\nmore()\n", "Intro.\n\n```js\nx(".length, id)).toEqual({ kind: "none" });
    // Closed, it still takes its id on a line after the fence.
    expect(apply("```js\nx()\n```\n", 7)).toBe("```js\nx()\n```\n\n^abc123\n");
  });

  it("a wrapped setext heading links by the id the preview gives it, from any of its lines (W1.32, Codex P2 on #238)", async () => {
    const md = "A wrapped\ntitle\n===\n\nbody\n";
    const first = blockIdEdit(md, 2, id);
    expect(first).toEqual({ kind: "heading", heading: headingSlug("A wrapped\ntitle") });
    expect(blockIdEdit(md, md.indexOf("title"), id)).toEqual(first);
    const { renderMarkdown } = await import("../renderer/pipeline");
    const { render } = await import("@testing-library/react");
    const { container } = render(await renderMarkdown(md, () => false));
    expect(container.querySelector("h1")?.id).toBe((first as { heading: string }).heading);
  }, 30_000);

  it("a repeated heading copies its numbered slug", () => {
    const md = "# Setup\n\ntext\n\n## Setup\n\n## Other\n";
    expect(blockIdEdit(md, md.indexOf("## Setup") + 3, id)).toEqual({ kind: "heading", heading: "setup-1" });
    expect(blockIdEdit(md, 2, id)).toEqual({ kind: "heading", heading: "Setup" });
  });

  it("a Lumen code block (mermaid, live code…) keeps its block id through the full pipeline", async () => {
    const { renderMarkdown } = await import("../renderer/pipeline");
    const { render } = await import("@testing-library/react");
    const el = await renderMarkdown("```mermaid\ngraph TD; A-->B\n```\n\n^diagram\n\n```js\nx()\n```\n\n^code\n\n[[#^diagram]]\n", () => false);
    const { container } = render(el);
    expect(container.querySelector('[id="^diagram"]')?.textContent ?? null).not.toBeNull();
    expect(container.querySelector('[id="^code"]')?.textContent).toContain("x()");
    expect(container.textContent).not.toContain("^code");
    expect(decodeURIComponent(container.querySelector("a.wiki-link")?.getAttribute("href") ?? "")).toBe("#^diagram");
  }, 30_000); // The first full render loads Shiki: slow on a busy machine.

  it("published pages link to block ids, not heading slugs", async () => {
    const { rewriteWikiLinks } = await import("../cli/publish");
    const pages = [
      { source: "Plans.md", output: "Plans.html" },
      { source: "Hub.md", output: "Hub.html" },
    ];
    const out = rewriteWikiLinks('<p id="^own">x</p><a class="wiki-link" data-wiki-target="#^own" href="#^own">a</a> <a class="wiki-link" data-wiki-target="Plans#^goal" href="#plansgoal">b</a>', "Hub.html", pages);
    expect(out).toContain('href="#^own"');
    expect(out).toContain('href="Plans.html#%5Egoal"');
  });
});

describe("review fixes, round 2 (PR #238)", () => {
  const id = () => "abc123";
  it("a long fence holding a shorter run of backticks is one code block", () => {
    const md = "````md\n```\ninner\n```\nlater code\n````\n";
    for (const at of [md.indexOf("inner") + 1, md.indexOf("later") + 1])
      expect(blockIdEdit(md, at, id)).toEqual({ kind: "block", id: "abc123", change: { from: md.lastIndexOf("````") + 4, insert: "\n\n^abc123" } });
  });

  it("setext headings give their heading link, on the text or the underline", () => {
    const md = "Title\n=====\n\nBody.\n\nTitle\n-----\n";
    expect(blockIdEdit(md, 1, id)).toEqual({ kind: "heading", heading: "Title" });
    expect(blockIdEdit(md, md.indexOf("=====") + 2, id)).toEqual({ kind: "heading", heading: "Title" });
    expect(blockIdEdit(md, md.lastIndexOf("-----") + 1, id)).toEqual({ kind: "heading", heading: "title-1" });
    // A wrapped setext title is still a heading, never given a block id.
    expect(blockIdEdit("A wrapped\ntitle\n===\n", 1, id)).toMatchObject({ kind: "heading" });
  });

  it("Vault Doctor compares block ids case-sensitively, like the preview", async () => {
    const { runVaultDoctor } = await import("../lint/vaultDoctor");
    const missing = runVaultDoctor([
      { path: "Plans.md", text: "Text ^Foo\n" },
      { path: "Hub.md", text: "[[Plans#^Foo]] and [[Plans#^foo]]\n" },
    ]).filter((f) => f.kind === "missing-heading");
    expect(missing.map((f) => f.detail)).toEqual(["Plans#^foo"]);
  });
});
