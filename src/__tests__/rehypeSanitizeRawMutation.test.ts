/**
 * Plan 0.15 — rehypeSanitizeRaw on hand-built trees (no Markdown pipeline,
 * no mocks), so mutation testing can run it anywhere.
 */
import { describe, expect, it } from "vitest";
import type { Element, Root } from "hast";
import { rehypeSanitizeRaw, safeClass, safeUrl } from "../renderer/rehypeSanitizeRaw";

const el = (tagName: string, properties: Record<string, unknown> = {}, children: Element["children"] = []): Element => ({ type: "element", tagName, properties: properties as Element["properties"], children });
const run = (...children: Root["children"]): Root => {
  const tree: Root = { type: "root", children };
  rehypeSanitizeRaw()(tree);
  return tree;
};
const tags = (t: Root) => (t.children as Element[]).map((c) => c.tagName ?? c.type);

describe("safeUrl", () => {
  it("allows web, mail and phone links and relative paths", () => {
    for (const u of ["https://x.org", "http://x.org", "mailto:a@b.c", "tel:+972", "/p", "./a.md", "#h", "a.md"]) expect(safeUrl(u, "a", "href"), u).toBe(true);
  });
  it("refuses script and other schemes, even split by whitespace or controls", () => {
    for (const u of ["javascript:alert(1)", "java\tscript:x", " javascript:x", "java\u0000script:x", "vbscript:x", "data:text/html,x", "file:///etc"]) expect(safeUrl(u, "a", "href"), u).toBe(false);
  });
  it("allows data images only as an image source", () => {
    expect(safeUrl("data:image/png;base64,AA", "img", "src")).toBe(true);
    expect(safeUrl("data:image/svg+xml;utf8,<svg/>", "source", "srcSet")).toBe(true);
    expect(safeUrl("data:image/png;base64,AA", "img", "href")).toBe(false);
    expect(safeUrl("data:image/png;base64,AA", "a", "src")).toBe(false);
    expect(safeUrl("data:image/tiff;base64,AA", "img", "src")).toBe(false);
  });
  it("lets frames load only https", () => {
    expect(safeUrl("https://x.org", "iframe", "src")).toBe(true);
    expect(safeUrl("http://x.org", "iframe", "src")).toBe(false);
    expect(safeUrl("/same-origin", "iframe", "src")).toBe(false);
  });
});

describe("safeClass", () => {
  it("keeps the pipeline's classes and code languages only", () => {
    expect(safeClass("task-list-item")).toBe(true);
    expect(safeClass("language-c++")).toBe(true);
    expect(safeClass("language-")).toBe(false);
    expect(safeClass("fixed-overlay")).toBe(false);
  });
});

describe("rehypeSanitizeRaw", () => {
  it("drops dangerous elements, raw nodes and doctypes, at any depth", () => {
    const t = run(el("p", {}, [el("script"), { type: "text", value: "x" }, el("style")]), el("form"), el("iframe", {}), { type: "raw", value: "<b>" } as never, { type: "doctype" } as never, el("div"));
    expect(tags(t)).toEqual(["p", "div"]);
    expect((t.children[0] as Element).children.map((c) => c.type)).toEqual(["text"]);
  });

  it("drops event handlers and dangerous properties, keeps the rest", () => {
    const t = run(el("img", { src: "https://x/a.png", onError: "x", onclick: "y", srcDoc: "z", ping: "p", alt: "a" }));
    expect((t.children[0] as Element).properties).toEqual({ src: "https://x/a.png", alt: "a" });
  });

  it("removes unsafe URLs, including array values", () => {
    const t = run(el("a", { href: "javascript:x" }), el("a", { href: ["https://x.org"] }), el("img", { src: "data:image/png;base64,AA" }));
    expect((t.children[0] as Element).properties.href).toBe(undefined);
    expect((t.children[1] as Element).properties.href).toEqual(["https://x.org"]);
    expect((t.children[2] as Element).properties.src).toBe("data:image/png;base64,AA");
  });

  it("filters classes, keeping only the pipeline's", () => {
    const t = run(el("li", { className: ["task-list-item", "evil"] }), el("p", { className: "evil other" }), el("code", { className: "language-js x" }));
    expect((t.children[0] as Element).properties.className).toEqual(["task-list-item"]);
    expect((t.children[1] as Element).properties.className).toBe(undefined);
    expect((t.children[2] as Element).properties.className).toEqual(["language-js"]);
  });

  it("cleans srcset entries one by one", () => {
    const t = run(el("img", { srcSet: "https://x/a.png 1x, javascript:x 2x" }), el("img", { srcSet: ["javascript:x 1x"] }));
    expect((t.children[0] as Element).properties.srcSet).toBe("https://x/a.png 1x");
    expect((t.children[1] as Element).properties.srcSet).toBe(undefined);
  });

  it("neutralises remote CSS and overlays in inline styles", () => {
    const t = run(el("p", { style: "background:url(https://x)" }), el("p", { style: "color:red;position: fixed" }), el("p", { style: "color:red" }));
    expect((t.children[0] as Element).properties.style).toBe(undefined);
    expect((t.children[1] as Element).properties.style).toBe("color:red;position: static");
    expect((t.children[2] as Element).properties.style).toBe("color:red");
  });

  it("keeps only disabled checkboxes among inputs", () => {
    const t = run(el("input", { type: "checkbox", checked: true }), el("input", { type: "text" }));
    expect(tags(t)).toEqual(["input"]);
    expect((t.children[0] as Element).properties.disabled).toBe(true);
  });

  it("adds noopener to links opening elsewhere, not to _self", () => {
    const t = run(el("a", { href: "https://x", target: "_blank" }), el("a", { href: "https://x", target: "_self" }), el("a", { href: "https://x" }));
    expect((t.children[0] as Element).properties.rel).toEqual(["noopener", "noreferrer"]);
    expect((t.children[1] as Element).properties.rel).toBe(undefined);
    expect((t.children[2] as Element).properties.rel).toBe(undefined);
  });

  it("sandboxes https frames and drops frames without a usable src", () => {
    const t = run(el("iframe", { src: "https://x.org/e" }), el("iframe", { src: "http://x.org" }), el("iframe", { src: ["https://x"] }));
    expect(tags(t)).toEqual(["iframe"]);
    expect((t.children[0] as Element).properties).toMatchObject({ sandbox: ["allow-scripts", "allow-presentation", "allow-same-origin"], referrerPolicy: "no-referrer", loading: "lazy" });
  });
});
