import { describe, it, expect } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import { visit } from "unist-util-visit";
import type { Element, Root } from "hast";
import { rehypeSanitizeRaw, safeUrl } from "../renderer/rehypeSanitizeRaw";

async function tree(md: string): Promise<Root> {
  const p = unified().use(remarkParse).use(remarkGfm).use(remarkRehype, { allowDangerousHtml: true }).use(rehypeRaw).use(rehypeSanitizeRaw);
  return (await p.run(p.parse(md))) as Root;
}

function elements(root: Root): Element[] {
  const out: Element[] = [];
  visit(root, "element", (n: Element) => {
    out.push(n);
  });
  return out;
}

const tags = (root: Root) => elements(root).map((e) => e.tagName);

describe("rehypeSanitizeRaw (T48)", () => {
  it("removes script, style, object, embed, form, meta and base elements", async () => {
    const t = await tree(
      'hi\n\n<script>alert(1)</script>\n<style>body{display:none}</style>\n<object data="x.swf"></object>\n<embed src="x">\n<form action="https://evil"><input name="p"></form>\n<meta http-equiv="refresh" content="0;url=https://evil">\n<base href="https://evil/">\n',
    );
    const list = tags(t);
    for (const bad of ["script", "style", "object", "embed", "form", "input", "meta", "base"]) expect(list).not.toContain(bad);
    expect(list).toContain("p");
  });

  it("drops event handlers and javascript: URLs but keeps safe links and images", async () => {
    const t = await tree(
      '<a href="javascript:alert(1)" onclick="x()">a</a> <a href="java\tscript:alert(1)">b</a> <a href="https://example.com">c</a> <a href="./note.md">d</a>\n<img src="x" onerror="alert(1)"> <img src="data:image/png;base64,AAAA"> <img src="data:text/html,<script>1</script>">\n',
    );
    const els = elements(t);
    const links = els.filter((e) => e.tagName === "a");
    expect(links.map((a) => a.properties.href)).toEqual([undefined, undefined, "https://example.com", "./note.md"]);
    expect(links.some((a) => "onClick" in a.properties)).toBe(false);
    const imgs = els.filter((e) => e.tagName === "img");
    expect(imgs.map((i) => i.properties.src)).toEqual(["x", "data:image/png;base64,AAAA", undefined]);
    expect(imgs.some((i) => "onError" in i.properties)).toBe(false);
  });

  it("strips srcdoc, requires an https iframe src and sandboxes it", async () => {
    const t = await tree(
      '<iframe srcdoc="<script>parent.x()</script>"></iframe>\n<iframe src="data:text/html,hi"></iframe>\n<iframe src="https://www.youtube-nocookie.com/embed/x"></iframe>\n',
    );
    const frames = elements(t).filter((e) => e.tagName === "iframe");
    expect(frames).toHaveLength(1);
    expect(frames[0].properties.src).toBe("https://www.youtube-nocookie.com/embed/x");
    expect(frames[0].properties.sandbox).toBeTruthy();
    expect("srcDoc" in frames[0].properties).toBe(false);
  });

  it("neutralises CSS that loads remote URLs or overlays the app", async () => {
    const t = await tree('<div style="background:url(https://track.example/p.gif)">a</div>\n<div style="position: fixed; inset: 0">b</div>\n');
    const divs = elements(t).filter((e) => e.tagName === "div");
    expect(divs[0].properties.style).toBeUndefined();
    expect(String(divs[1].properties.style)).toContain("position: static");
  });

  it("drops host-app classes that would restore fixed positioning, keeps pipeline classes", async () => {
    const t = await tree(
      '<div class="lumen-slash-menu" style="inset:0;width:100vw;height:100vh">a</div>\n<div class="fixed inset-0 z-50 admonition warning">b</div>\n\n- [ ] todo\n\n```js\nx\n```\n',
    );
    const divs = elements(t).filter((e) => e.tagName === "div");
    expect(divs[0].properties.className).toBeUndefined();
    expect(divs[1].properties.className).toEqual(["admonition", "warning"]);
    const li = elements(t).find((e) => e.tagName === "li");
    expect(li?.properties.className).toEqual(["task-list-item"]);
    const code = elements(t).find((e) => e.tagName === "code");
    expect(code?.properties.className).toEqual(["language-js"]);
  });

  it("rejects scheme-less iframe sources (would be same-origin with the app)", async () => {
    const t = await tree('<iframe src="/"></iframe>\n<iframe src="./x.html"></iframe>\n<iframe src="//evil.example/x"></iframe>\n');
    expect(elements(t).filter((e) => e.tagName === "iframe")).toHaveLength(0);
    expect(safeUrl("/", "iframe", "src")).toBe(false);
    expect(safeUrl("/", "img", "src")).toBe(true);
  });

  it("keeps GFM task-list checkboxes (disabled) and ordinary inline HTML", async () => {
    const t = await tree("- [x] done\n- [ ] todo\n\n<details><summary>More</summary>\n\n<kbd>Ctrl</kbd> <mark>hi</mark>\n\n</details>\n");
    const list = tags(t);
    expect(list.filter((x) => x === "input")).toHaveLength(2);
    expect(list).toEqual(expect.arrayContaining(["details", "summary", "kbd", "mark"]));
    const boxes = elements(t).filter((e) => e.tagName === "input");
    expect(boxes.every((b) => b.properties.disabled)).toBe(true);
  });

  it("safeUrl: the scheme rules", () => {
    expect(safeUrl("#heading", "a", "href")).toBe(true);
    expect(safeUrl("mailto:a@b.c", "a", "href")).toBe(true);
    expect(safeUrl("vbscript:x", "a", "href")).toBe(false);
    expect(safeUrl(" JAVASCRIPT:x", "a", "href")).toBe(false);
    expect(safeUrl("http://x", "iframe", "src")).toBe(false);
    expect(safeUrl("data:image/png;base64,AA", "a", "href")).toBe(false);
  });
});
