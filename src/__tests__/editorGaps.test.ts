/**
 * Editor gaps against Obsidian 1.12 and Heptabase (plan W7.3): image size
 * reset, attachments left by a deleted note, copy as HTML, the backlinks
 * list, and search inside code blocks and folded lists.
 */
import { describe, it, expect } from "vitest";
import { clearImageWidth, setImageWidth } from "../renderer/imageSize";
import { attachmentRefsOf, orphanAttachments } from "../storage/attachmentRefs";
import { directionOf, markdownToClipboardHtml } from "../editor/copyHtml";
import { imageEmbedAt } from "../editor/copyEvents";
import { groupBacklinks } from "../ui/backlinksGroup";
import { VaultIndex } from "../storage/vaultIndexCore";

describe("image size reset (double-click on the edge)", () => {
  it("takes the size off an embed and keeps its other parameters", () => {
    expect(clearImageWidth("x ![[a.png|300]] y", 2)).toBe("x ![[a.png]] y");
    expect(clearImageWidth("![[a.png|A cat|100x50]]", 0)).toBe("![[a.png|A cat]]");
    expect(clearImageWidth("![dog|320](d.png)", 0)).toBe("![dog](d.png)");
    expect(clearImageWidth("![[תמונה.png|120]]", 0)).toBe("![[תמונה.png]]");
  });
  it("is the inverse of a resize, and finds the image when the note moved on", () => {
    const md = "שלום ![[a.png]] עולם";
    expect(clearImageWidth(setImageWidth(md, 5, 240), 5)).toBe(md);
    expect(clearImageWidth("new\n\n![[a.png|200]]", 0, "a.png")).toBe("new\n\n![[a.png]]");
    expect(clearImageWidth("no images", 3, "a.png")).toBe("no images");
  });
});

describe("attachments a deleted note leaves", () => {
  it("reads wiki embeds, Markdown images and links to files, and skips notes and URLs", () => {
    const refs = attachmentRefsOf("![[a.png|300]] [[b.pdf#page=2]] [[note]] [[other.md]] ![x](img/c%20d.jpg) [w](https://x.example.com/e.png) [doc](<f g.docx>) `[[h.png]]`");
    expect(refs.map((r) => r.target)).toEqual(["a.png", "b.pdf", "h.png", "img/c d.jpg", "f g.docx"]);
  });

  it("offers only what no surviving note links to", () => {
    const files = ["a.md", "b.md", "att/one.png", "att/two.png", "att/three.pdf", "c.canvas"];
    const notes = [
      { path: "a.md", content: "![[one.png]] ![[two.png]] [[three.pdf]]" },
      { path: "b.md", content: "![x](att/two.png)" },
      { path: "c.canvas", content: '{"nodes":[{"type":"file","file":"att/three.pdf"}]}' },
    ];
    expect(orphanAttachments({ deleted: ["a.md"], notes, files })).toEqual(["att/one.png"]);
    // A folder delete: what is inside goes anyway, so it is not listed.
    expect(orphanAttachments({ deleted: ["att"], notes, files })).toEqual([]);
  });

  it("an ambiguous name in a surviving note keeps every file with that name", () => {
    const files = ["x/a.md", "y/b.md", "x/pic.png", "y/pic.png"];
    const notes = [
      { path: "x/a.md", content: "![[pic.png]]" },
      { path: "y/b.md", content: "![[pic.png]]" },
    ];
    expect(orphanAttachments({ deleted: ["x/a.md"], notes, files })).toEqual([]);
  });

  it("200 random vaults: no attachment another note links to is ever offered", () => {
    // mulberry32: a seeded generator whose low bits are not periodic.
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return (((x ^ (x >>> 14)) >>> 0) % 4294967296) % n;
    };
    const dirs = ["", "a", "a/b", "ת"];
    let offeredRuns = 0;
    for (let run = 0; run < 200; run++) {
      const atts = Array.from({ length: 2 + rnd(8) }, (_, i) => `${dirs[rnd(dirs.length)]}/${["p", "q", "תמונה"][rnd(3)]}${i % 3}.${["png", "pdf", "jpg"][rnd(3)]}`.replace(/^\//, ""));
      const noteNames = Array.from({ length: 2 + rnd(6) }, (_, i) => `${dirs[rnd(dirs.length)]}/n${i}.md`.replace(/^\//, ""));
      const files = [...new Set([...atts, ...noteNames])];
      // Each surviving link remembers the file it was written for: the oracle.
      const linkedTo = new Map<string, Set<string>>();
      const link = (att: string, from: string) => {
        const to = linkedTo.get(from) ?? new Set<string>();
        linkedTo.set(from, to.add(att));
        const name = att.split("/").pop()!;
        const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
        switch (rnd(4)) {
          case 0: return `![[${name}|${100 + rnd(300)}]]`;
          case 1: return `![[${att}]]`;
          case 2: return dir && att.startsWith(dir + "/") ? `![i](${encodeURI(att.slice(dir.length + 1))})` : `![i](/${encodeURI(att)})`;
          default: return `[[${name}]]`;
        }
      };
      const notes = noteNames.map((p) => ({ path: p, content: Array.from({ length: rnd(4) }, () => link(atts[rnd(atts.length)], p)).join(" text ") }));
      const deleted = [noteNames[rnd(noteNames.length)]];
      const offered = orphanAttachments({ deleted, notes, files });
      if (offered.length) offeredRuns++;
      for (const o of offered) {
        for (const n of notes) {
          if (deleted.includes(n.path)) continue;
          expect(linkedTo.get(n.path)?.has(o) ?? false, `run ${run}: ${o} is linked from ${n.path}`).toBe(false);
        }
        // And the deleted note did link to it.
        expect(linkedTo.get(deleted[0])?.has(o) || [...(linkedTo.get(deleted[0]) ?? [])].some((a) => a.split("/").pop() === o.split("/").pop()), `run ${run}: ${o}`).toBe(true);
      }
    }
    // The property is not empty: many runs do offer something.
    expect(offeredRuns).toBeGreaterThan(40);
  });
});

describe("copy as HTML", () => {
  const cases: Array<[string, string, RegExp[]]> = [
    ["heading en", "# Title", [/<h1 dir="ltr">Title<\/h1>/]],
    ["heading he", "## כותרת", [/<h2 dir="rtl">כותרת<\/h2>/, /^<div dir="rtl">/]],
    ["bold and italics", "שלום **מודגש** ו-*נטוי*", [/<strong>מודגש<\/strong>/, /<em>נטוי<\/em>/, /<p dir="rtl">/]],
    ["mixed paragraph", "Lumen הוא עורך", [/<p dir="ltr">/]],
    ["lists", "- אחד\n- שתיים\n  1. sub", [/<ul dir="rtl"><li dir="rtl">אחד<\/li><li dir="rtl">שתיים<ol dir="ltr"><li dir="ltr">sub<\/li><\/ol><\/li><\/ul>/]],
    ["task list", "- [x] done\n- [ ] todo", [/☑ done/, /☐ todo/]],
    ["code block", "```js\nif (a < b) x()\n```", [/<pre dir="ltr"><code>if \(a &lt; b\) x\(\)<\/code><\/pre>/]],
    ["link", "[אתר](https://example.com/?a=1&b=2)", [/<a href="https:\/\/example.com\/\?a=1&amp;b=2">אתר<\/a>/]],
    ["unsafe link", "[x](javascript:alert(1))", [/^(?!.*href).*$/s]],
    ["quote and highlight", "> ==חשוב== מאוד", [/<blockquote dir="rtl"><mark>חשוב<\/mark> מאוד<\/blockquote>/]],
  ];
  for (const [name, md, want] of cases) {
    it(name, () => {
      const html = markdownToClipboardHtml(md);
      for (const re of want) expect(html).toMatch(re);
      expect(html).not.toMatch(/<script/i);
    });
  }
  it("escapes HTML in the text and drops frontmatter", () => {
    expect(markdownToClipboardHtml("---\ntitle: x\n---\n<img src=x onerror=alert(1)>")).toBe('<div dir="ltr"><p dir="ltr">&lt;img src=x onerror=alert(1)&gt;</p></div>');
  });
  it("direction follows the first strong character", () => {
    expect(directionOf("123 שלום world")).toBe("rtl");
    expect(directionOf("— hello עולם")).toBe("ltr");
    expect(directionOf("")).toBe("ltr");
  });
});

describe("Copy image: the embed under the pointer", () => {
  it("finds an image embed at the column and ignores other links", () => {
    const line = "טקסט ![[pic.png|200]] ו-![x](img/a.jpg) [[note]] ![[doc.pdf]]";
    expect(imageEmbedAt(line, 8)).toBe("pic.png");
    expect(imageEmbedAt(line, line.indexOf("img/a") + 1)).toBe("img/a.jpg");
    expect(imageEmbedAt(line, line.indexOf("[[note")+2)).toBeNull();
    expect(imageEmbedAt(line, line.indexOf("doc.pdf"))).toBeNull();
    expect(imageEmbedAt(line, 0)).toBeNull();
  });
});

describe("backlinks: search, sort and a group per note", () => {
  const hits = [
    { fromPath: "b/בית.md", fromName: "בית", snippet: "קישור אל [[x]] בבית", offset: 40 },
    { fromPath: "a/Alpha.md", fromName: "Alpha", snippet: "see [[x]] here", offset: 3 },
    { fromPath: "b/בית.md", fromName: "בית", snippet: "עוד [[x]] בשָׁלוֹם", offset: 10 },
    { fromPath: "c/Beta.md", fromName: "Beta", snippet: "Beta [[x]]", offset: 0 },
  ];
  it("groups by note, hits in text order", () => {
    const g = groupBacklinks(hits, { locale: "en" });
    expect(g.map((x) => x.fromName)).toEqual(["Alpha", "Beta", "בית"]);
    expect(g[2].hits.map((h) => h.offset)).toEqual([10, 40]);
  });
  it("sorts by modified, newest first", () => {
    const modified = new Map([["a/Alpha.md", 1], ["c/Beta.md", 3], ["b/בית.md", 2]]);
    expect(groupBacklinks(hits, { sort: "modified", modified }).map((x) => x.fromName)).toEqual(["Beta", "בית", "Alpha"]);
  });
  it("searches names and snippets, niqqud and case aside", () => {
    expect(groupBacklinks(hits, { query: "שלום" }).map((g) => [g.fromName, g.hits.length])).toEqual([["בית", 1]]);
    expect(groupBacklinks(hits, { query: "ALPHA" }).map((g) => g.fromName)).toEqual(["Alpha"]);
    expect(groupBacklinks(hits, { query: "nothing" })).toEqual([]);
  });
});

describe("search finds text inside code blocks and folded lists", () => {
  it("both are in the index", () => {
    const idx = new VaultIndex();
    idx.upsert({ path: "code.md", name: "code.md", content: "# Code\n\n```python\ndef quixotic_helper():\n    return 1\n```\n", modified: 1 });
    idx.upsert({ path: "list.md", name: "list.md", content: "- parent\n  - child\n    - deeply nested zephyrword\n", modified: 1 });
    idx.upsert({ path: "he.md", name: "he.md", content: "- הורה\n    - ילד מקופל מילתקוד\n", modified: 1 });
    expect(idx.search("quixotic_helper").map((h) => h.path)).toContain("code.md");
    expect(idx.search("zephyrword").map((h) => h.path)).toContain("list.md");
    expect(idx.search("מילתקוד").map((h) => h.path)).toContain("he.md");
  });
});
