/**
 * Plan 4.7 — Obsidian-style embeds in the preview: `![[note]]`,
 * `![[note#heading]]`, `![[note#^block]]`, `![[image.png|300]]`,
 * `![[file.pdf]]`, with depth and cycle guards and the same sanitizer as
 * the host note.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown, renderMarkdownFast } from "../renderer/pipeline";
import { createEmbedContext, embeddedTexts, hasEmbeds, MAX_EMBED_DEPTH, parseEmbed, resolveEmbedTarget, type EmbedContext } from "../renderer/embeds";
import { embedNotice, hostPathOf } from "../renderer/embedContext";

const VAULT: Record<string, string> = {
  "Note.md":
    "# Note\n\nIntro paragraph.\n\n## Install\n\nRun the installer.\n\n### Details\n\nDeep detail.\n\n## Usage\n\nUse it. ^use-block\n\n- item one\n- item two ^list-block\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n^table-block\n",
  "folder/Deep.md": "Deep note body.",
  "a/Twin.md": "Twin in a",
  "b/Twin.md": "Twin in b",
  "notes/Hebrew שלום.md": "# כותרת\n\nשלום עולם, זה פתק בעברית.",
  "attachments/pic.png": "",
  "attachments/Pasted image 1.png": "",
  "docs/spec.pdf": "",
  "Self.md": "Before ![[Self]] after",
  "A.md": "A says\n\n![[B]]",
  "B.md": "B says\n\n![[A]]",
  "L1.md": "level one\n\n![[L2]]",
  "L2.md": "level two\n\n![[L3]]",
  "L3.md": "level three\n\n![[L4]]",
  "L4.md": "level four",
  "Code.md": "```js\nconst answer = 42;\n```\n",
  "Unsafe.md": '<img src="x.png" onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">bad link</a> safe text',
  "Math.md": "Euler: $e^{i\\pi}+1=0$",
  "Front.md": "---\ntitle: Hidden\n---\nBody after frontmatter",
  "Links.md": "See [[Note]] and [[Note#Install|install]].",
  "Sections.md": "## One\n\nfirst ![[#Two]]\n\n## Two\n\nsecond",
};

function ctxFor(hostText: string, hostPath: string | null = "host.md", vault = VAULT): EmbedContext {
  return createEmbedContext({
    hostPath,
    hostText,
    files: Object.entries(vault).map(([path, content]) => ({ path, content })),
    notice: embedNotice,
  });
}

/** Fast (synchronous) render of `md` with the vault above, as a DOM tree. */
function dom(md: string, hostPath: string | null = "host.md"): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(renderMarkdownFast(md, { embeds: ctxFor(md, hostPath) }));
  return root;
}

const embed = (root: HTMLElement) => root.querySelector<HTMLElement>(".lumen-embed");
const status = (root: HTMLElement) => root.querySelector<HTMLElement>(".lumen-embed-notice")?.dataset.embedStatus;
const body = (root: HTMLElement) => root.querySelector(".lumen-embed-body")?.textContent ?? "";

interface Case {
  name: string;
  md: string;
  host?: string | null;
  check: (root: HTMLElement) => void;
}

const CASES: Case[] = [
  {
    name: "whole note",
    md: "![[Note]]",
    check: (r) => {
      expect(embed(r)?.dataset.embedPath).toBe("Note.md");
      expect(body(r)).toContain("Intro paragraph.");
      expect(body(r)).toContain("Deep detail.");
    },
  },
  { name: "explicit .md extension", md: "![[Note.md]]", check: (r) => expect(embed(r)?.dataset.embedPath).toBe("Note.md") },
  { name: "name is case-insensitive", md: "![[note]]", check: (r) => expect(embed(r)?.dataset.embedPath).toBe("Note.md") },
  {
    name: "section: heading up to the next heading of the same level",
    md: "![[Note#Install]]",
    check: (r) => {
      expect(body(r)).toContain("Run the installer.");
      expect(body(r)).toContain("Deep detail."); // a subsection belongs to it
      expect(body(r)).not.toContain("Intro paragraph.");
      expect(body(r)).not.toContain("Use it.");
      expect(r.querySelector(".lumen-embed-body h2")?.textContent).toBe("Install");
    },
  },
  { name: "section heading is case-insensitive", md: "![[Note#install]]", check: (r) => expect(body(r)).toContain("Run the installer.") },
  {
    name: "nested heading path",
    md: "![[Note#Install#Details]]",
    check: (r) => {
      expect(body(r)).toContain("Deep detail.");
      expect(body(r)).not.toContain("Run the installer.");
    },
  },
  {
    name: "missing section",
    md: "![[Note#Nowhere]]",
    check: (r) => {
      expect(status(r)).toBe("sectionNotFound");
      expect(r.textContent).toContain("Nowhere");
    },
  },
  {
    name: "block reference on a paragraph",
    md: "![[Note#^use-block]]",
    check: (r) => {
      expect(body(r)).toContain("Use it.");
      expect(body(r)).not.toContain("^use-block");
      expect(body(r)).not.toContain("Run the installer.");
    },
  },
  {
    name: "block reference on a list item",
    md: "![[Note#^list-block]]",
    check: (r) => {
      expect(body(r)).toContain("item two");
      expect(body(r)).not.toContain("item one");
    },
  },
  {
    name: "block reference on its own line names the block before it",
    md: "![[Note#^table-block]]",
    check: (r) => expect(r.querySelector(".lumen-embed-body table")).not.toBeNull(),
  },
  { name: "alias is ignored for notes", md: "![[Note|my alias]]", check: (r) => expect(body(r)).toContain("Intro paragraph.") },
  { name: "folder path", md: "![[folder/Deep]]", check: (r) => expect(body(r)).toBe("Deep note body.") },
  { name: "short name of a nested note", md: "![[Deep]]", check: (r) => expect(embed(r)?.dataset.embedPath).toBe("folder/Deep.md") },
  { name: "same name: the note next to the host wins", md: "![[Twin]]", host: "b/host.md", check: (r) => expect(body(r)).toBe("Twin in b") },
  { name: "relative path", md: "![[../a/Twin]]", host: "b/host.md", check: (r) => expect(body(r)).toBe("Twin in a") },
  {
    name: "missing note",
    md: "![[No Such Note]]",
    check: (r) => {
      expect(status(r)).toBe("notFound");
      expect(r.querySelector("div.lumen-embed-notice")?.textContent).toContain("No Such Note");
    },
  },
  {
    name: "image",
    md: "![[pic.png]]",
    check: (r) => {
      const img = r.querySelector("img.lumen-embed-image");
      expect(img?.getAttribute("data-lumen-path")).toBe("attachments/pic.png");
      expect(img?.getAttribute("alt")).toBe("pic");
      // Read from OPFS, never requested from the server by its path.
      expect(img?.getAttribute("src")).toBeNull();
    },
  },
  { name: "image width", md: "![[pic.png|300]]", check: (r) => expect(r.querySelector("img")?.getAttribute("width")).toBe("300") },
  {
    name: "image alt and size",
    md: "![[pic.png|a cat|300x200]]",
    check: (r) => {
      const img = r.querySelector("img")!;
      expect(img.getAttribute("alt")).toBe("a cat");
      expect(img.getAttribute("width")).toBe("300");
      expect(img.getAttribute("height")).toBe("200");
    },
  },
  {
    name: "image name with spaces, inline in text",
    md: "Look: ![[Pasted image 1.png]] here",
    check: (r) => {
      expect(r.querySelector("p img")?.getAttribute("data-lumen-path")).toBe("attachments/Pasted image 1.png");
      expect(r.querySelector("p")?.textContent).toContain("Look:");
    },
  },
  { name: "missing image", md: "![[gone.png]]", check: (r) => expect(r.querySelector<HTMLElement>("span.lumen-embed-notice")?.dataset.embedStatus).toBe("notFound") },
  {
    name: "image in a table cell (escaped pipe)",
    md: "| pic |\n|---|\n| ![[pic.png\\|50]] |\n",
    check: (r) => expect(r.querySelector("td img")?.getAttribute("width")).toBe("50"),
  },
  {
    name: "PDF card",
    md: "![[spec.pdf]]",
    check: (r) => {
      const card = r.querySelector<HTMLElement>(".lumen-embed-file");
      expect(card?.dataset.embedPath).toBe("docs/spec.pdf");
      expect(card?.textContent).toContain("spec.pdf");
      expect(card?.querySelector("button")?.textContent).toBe("Open PDF");
    },
  },
  { name: "a note embedding itself", md: "Before ![[Self]] after", host: "Self.md", check: (r) => expect(status(r)).toBe("cycle") },
  {
    name: "a cycle through another note",
    md: "![[A]]",
    check: (r) => {
      expect(r.textContent).toContain("A says");
      expect(r.textContent).toContain("B says");
      expect(status(r)).toBe("cycle");
      expect(r.querySelectorAll(".lumen-embed")).toHaveLength(2);
    },
  },
  {
    name: `nesting stops at depth ${MAX_EMBED_DEPTH}`,
    md: "![[L1]]",
    check: (r) => {
      expect(r.textContent).toContain("level three");
      expect(r.textContent).not.toContain("level four");
      expect(status(r)).toBe("depth");
      expect(r.querySelectorAll(".lumen-embed")).toHaveLength(MAX_EMBED_DEPTH);
    },
  },
  {
    name: "an embed inside a paragraph splits it (no block in a <p>)",
    md: "Intro\n![[folder/Deep]]\noutro",
    check: (r) => {
      expect(r.querySelector("p .lumen-embed")).toBeNull();
      const kids = Array.from(r.children).map((c) => c.tagName + (c.classList.contains("lumen-embed") ? ".embed" : ""));
      expect(kids).toEqual(["P", "DIV.embed", "P"]);
    },
  },
  { name: "inside a list item", md: "- item\n  ![[folder/Deep]]\n", check: (r) => expect(r.querySelector("li > .lumen-embed")).not.toBeNull() },
  { name: "inside a callout", md: ":::note\n![[folder/Deep]]\n:::\n", check: (r) => expect(r.querySelector(".admonition .lumen-embed")).not.toBeNull() },
  {
    name: "inline code stays literal",
    md: "`![[Note]]`",
    check: (r) => {
      expect(embed(r)).toBeNull();
      expect(r.querySelector("code")?.textContent).toBe("![[Note]]");
    },
  },
  { name: "fenced code stays literal", md: "```\n![[Note]]\n```\n", check: (r) => expect(embed(r)).toBeNull() },
  {
    name: "in a heading it is a link, not an embed",
    md: "# Title ![[Note]]",
    check: (r) => {
      expect(embed(r)).toBeNull();
      expect(r.querySelector("h1 a.wiki-link")?.getAttribute("data-wiki-target")).toBe("Note");
    },
  },
  {
    name: "same-note section",
    md: "![[#Usage]]\n\n## Usage\n\nhow to use",
    check: (r) => {
      expect(body(r)).toContain("how to use");
      expect(embed(r)?.querySelector(".lumen-embed-title a")?.getAttribute("href")).toBe("#usage");
    },
  },
  {
    name: "a section of the embedded note that embeds its own sibling section",
    md: "![[Sections#One]]",
    check: (r) => {
      expect(r.textContent).toContain("first");
      expect(r.textContent).toContain("second");
      expect(status(r)).toBeUndefined();
    },
  },
  {
    name: "Hebrew note: name matched, embed is right-to-left",
    md: "![[Hebrew שלום]]",
    check: (r) => {
      expect(embed(r)?.getAttribute("dir")).toBe("rtl");
      expect(body(r)).toContain("שלום עולם");
    },
  },
  { name: "English note embedded is left-to-right", md: "![[folder/Deep]]", check: (r) => expect(embed(r)?.getAttribute("dir")).toBe("ltr") },
  {
    name: "frontmatter of the embedded note is not shown",
    md: "![[Front]]",
    check: (r) => {
      expect(body(r)).toContain("Body after frontmatter");
      expect(body(r)).not.toContain("Hidden");
    },
  },
  {
    name: "wiki links inside the embed work",
    md: "![[Links]]",
    check: (r) => expect(r.querySelector(".lumen-embed-body a.wiki-link[data-wiki-target='Note']")).not.toBeNull(),
  },
  {
    name: "Lumen blocks / code inside the embed render",
    md: "![[Code]]",
    check: (r) => expect(r.querySelector(".lumen-embed-body pre code")?.textContent).toContain("const answer = 42;"),
  },
  {
    name: "the host's heading ids do not shift",
    md: "![[Note]]\n\n# Note",
    check: (r) => {
      const ids = Array.from(r.querySelectorAll("h1, h2, h3")).map((h) => h.id);
      expect(ids[ids.length - 1]).toBe("note");
      expect(ids.slice(0, -1).every((id) => id.startsWith("embed-"))).toBe(true);
    },
  },
  {
    name: "title links to the source note",
    md: "![[Note#Install]]",
    check: (r) => expect(r.querySelector(".lumen-embed-title a.wiki-link")?.getAttribute("data-wiki-target")).toBe("Note#Install"),
  },
  { name: "no workspace file for the host", md: "![[folder/Deep]]", host: null, check: (r) => expect(body(r)).toBe("Deep note body.") },
];

describe("embeds — Obsidian syntax", () => {
  it.each(CASES)("$name", ({ md, host, check }) => {
    check(dom(md, host === undefined ? "host.md" : host));
  });
});

describe("embeds — pipeline", () => {
  it("without a context an embed is a plain wiki link", () => {
    const html = renderToStaticMarkup(renderMarkdownFast("![[Note#Install|x]]"));
    expect(html).toContain('data-wiki-target="Note#Install"');
    expect(html).not.toContain("!");
    expect(html).not.toContain("lumen-embed");
  });

  it("a line that is nothing but a wiki link is a link (the no-context fallback relies on it)", () => {
    const html = renderToStaticMarkup(renderMarkdownFast("[[Note]]\n\n- [[Other|label]]"));
    expect(html).toContain('data-wiki-target="Note"');
    expect(html).toContain('data-wiki-target="Other"');
  });

  it("embedded raw HTML goes through the sanitizer even when the host has none", async () => {
    const md = "Host text without HTML.\n\n![[Unsafe]]";
    const html = renderToStaticMarkup(await renderMarkdown(md, () => false, { embeds: ctxFor(md) }));
    expect(html).toContain("safe text");
    expect(html).toContain("lumen-embed"); // the sanitizer keeps the pipeline's own classes
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  it("embedded math gets KaTeX even when the host has none", async () => {
    const md = "![[Math]]";
    const html = renderToStaticMarkup(await renderMarkdown(md, () => false, { embeds: ctxFor(md) }));
    expect(html).toContain("katex");
  });

  it("a cycle is a notice in the full pipeline too, never a hang", async () => {
    const md = "![[A]]";
    const html = renderToStaticMarkup(await renderMarkdown(md, () => false, { embeds: ctxFor(md) }));
    expect(html).toContain('data-embed-status="cycle"');
  });

  it("records what it embedded, for live updates", () => {
    const md = "![[A]] ![[pic.png]]";
    const ctx = ctxFor(md);
    renderMarkdownFast(md, { embeds: ctx });
    expect([...ctx.used].sort()).toEqual(["A.md", "B.md", "attachments/pic.png"]);
  });

  it("a note met deep in one branch is scanned again where it is embedded higher up", async () => {
    // host → X1 → X2 → C: C's own embed is past the depth limit there. host → C:
    // C's embed of D renders, so D's math must select KaTeX.
    const vault = { "X1.md": "![[X2]]", "X2.md": "![[C]]", "C.md": "![[D]]", "D.md": "math: $x^2$" };
    const md = "![[X1]]\n\n![[C]]";
    const ctx = ctxFor(md, "host.md", vault);
    expect(embeddedTexts(md, ctx)).toContain("math: $x^2$");
    const html = renderToStaticMarkup(await renderMarkdown(md, () => false, { embeds: ctxFor(md, "host.md", vault) }));
    expect(html).toContain("katex");
  });

  it("a pasted asset the context does not list is missing, one it lists is shown", () => {
    const md = "![[lumen-asset-gone.png]]";
    expect(dom(md).querySelector<HTMLElement>(".lumen-embed-notice")?.dataset.embedStatus).toBe("notFound");
    const ctx = createEmbedContext({ hostPath: "h.md", hostText: md, files: [{ path: "lumen-asset-gone.png", content: "" }], notice: embedNotice });
    const root = document.createElement("div");
    root.innerHTML = renderToStaticMarkup(renderMarkdownFast(md, { embeds: ctx }));
    expect(root.querySelector("img")?.getAttribute("data-lumen-path")).toBe("lumen-asset-gone.png");
  });

  it("an embedded image carries its file's version, so a saved-over image is read again", () => {
    const md = "![[pic.png]]";
    const ctx = createEmbedContext({ hostPath: "h.md", hostText: md, files: [{ path: "pic.png", content: "", modified: 1234 }], notice: embedNotice });
    const root = document.createElement("div");
    root.innerHTML = renderToStaticMarkup(renderMarkdownFast(md, { embeds: ctx }));
    expect(root.querySelector("img")?.getAttribute("data-lumen-version")).toBe("1234");
  });

  it("collects embedded sources transitively for the pipeline's raw / math choice", () => {
    expect(embeddedTexts("![[L1]]", ctxFor("![[L1]]"))).toEqual([VAULT["L1.md"], VAULT["L2.md"], VAULT["L3.md"]]);
    expect(embeddedTexts("![[Self]]", ctxFor("![[Self]]", "Self.md"))).toEqual([]);
  });
});

describe("embeds — helpers", () => {
  it("parses target, fragment and alias", () => {
    expect(parseEmbed(" Note # Sec | alias ")).toEqual({ target: "Note # Sec", note: "Note", fragment: "Sec", alias: "alias" });
    expect(parseEmbed("#Only")).toEqual({ target: "#Only", note: "", fragment: "Only", alias: null });
  });

  it("detects embeds", () => {
    expect(hasEmbeds("a ![[b]] c")).toBe(true);
    expect(hasEmbeds("a [[b]] c")).toBe(false);
  });

  it("resolves by path, name and niqqud-insensitive Hebrew", () => {
    const paths = ["x/שלום.md", "pic.png", "y/pic.png"];
    expect(resolveEmbedTarget("שָׁלוֹם", paths, null, "note")).toBe("x/שלום.md");
    expect(resolveEmbedTarget("pic.png", paths, "y/n.md", "image")).toBe("pic.png");
    expect(resolveEmbedTarget("y/pic.png", paths, null, "image")).toBe("y/pic.png");
    expect(resolveEmbedTarget("pic", paths, null, "note")).toBeNull();
  });

  it("maps the preview's doc key to the host path", () => {
    expect(hostPathOf("ws:notes/a.md")).toBe("notes/a.md");
    expect(hostPathOf("name:a.md")).toBeNull();
    expect(hostPathOf(null)).toBeNull();
  });
});
