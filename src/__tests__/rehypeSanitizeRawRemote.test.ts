/**
 * Plan W4.17 — rehypeSanitizeRaw's other-site loads (dropRemoteLoads) on
 * hand-built trees, for the mutants that survived rehypeSanitizeRawMutation:
 * posters and backgrounds, hrefs on elements that load them, and audio /
 * video with their <source> and <track> children. The page's origin is the
 * test environment's location; "other.example" is another site.
 */
import { describe, expect, it } from "vitest";
import type { Element, Root } from "hast";
import { rehypeSanitizeRaw } from "../renderer/rehypeSanitizeRaw";

const el = (tagName: string, properties: Record<string, unknown> = {}, children: Element["children"] = []): Element => ({ type: "element", tagName, properties: properties as Element["properties"], children });
const clean = (node: Element): Element => {
  const tree: Root = { type: "root", children: [node] };
  rehypeSanitizeRaw()(tree);
  return tree.children[0] as Element;
};
const REMOTE = "https://other.example/a.png";

describe("rehypeSanitizeRaw: loads from other sites", () => {
  it("drops an other-site poster or background, keeps a same-site one", () => {
    expect(clean(el("video", { poster: REMOTE })).properties.poster).toBeUndefined();
    expect(clean(el("video", { poster: "/local.png" })).properties.poster).toBe("/local.png");
    expect(clean(el("td", { background: REMOTE })).properties.background).toBeUndefined();
    expect(clean(el("td", { background: "bg.png" })).properties.background).toBe("bg.png");
  });

  it("drops an other-site href on an element that loads it, not on a link", () => {
    expect(clean(el("image", { xLinkHref: REMOTE })).properties.xLinkHref).toBeUndefined();
    expect(clean(el("use", { href: REMOTE })).properties.href).toBeUndefined();
    expect(clean(el("use", { href: "#icon" })).properties.href).toBe("#icon");
    expect(clean(el("a", { href: REMOTE })).properties.href).toBe(REMOTE);
    expect(clean(el("area", { href: REMOTE })).properties.href).toBe(REMOTE);
  });

  it("never autoplays and never preloads audio or video; other elements keep their attributes", () => {
    for (const tag of ["video", "audio"]) {
      const p = clean(el(tag, { autoPlay: true, src: "/a.webm" })).properties;
      expect(p.autoPlay, tag).toBeUndefined();
      expect(p.preload, tag).toBe("none");
    }
    const img = clean(el("img", { src: "/a.png", title: "x" })).properties;
    expect(img.preload).toBeUndefined();
    expect(img.title).toBe("x");
  });

  it("hoists the first other-site <source> to the video's src and drops other-site children", () => {
    const v = clean(
      el("video", {}, [
        el("source", { src: "/local.webm" }),
        el("track", { src: "https://other.example/subs.vtt" }),
        el("source", { src: "https://other.example/first.webm" }),
        el("source", { src: "https://other.example/second.webm" }),
        { type: "text", value: "fallback" },
      ]),
    );
    expect(v.properties.src).toBe("https://other.example/first.webm");
    expect(v.children.map((k) => (k.type === "element" ? `${k.tagName} ${String(k.properties.src)}` : k.type))).toEqual(["source /local.webm", "text"]);
  });

  it("keeps the video's own src instead of hoisting, and does not hoist a <track>", () => {
    const own = clean(el("video", { src: "/mine.webm" }, [el("source", { src: "https://other.example/x.webm" })]));
    expect(own.properties.src).toBe("/mine.webm");
    expect(own.children).toEqual([]);
    const track = clean(el("audio", {}, [el("track", { src: "https://other.example/subs.vtt" })]));
    expect(track.properties.src).toBeUndefined();
    expect(track.children).toEqual([]);
    const local = clean(el("audio", {}, [el("source", { src: "/a.ogg" })]));
    expect(local.properties.src).toBeUndefined();
    expect(local.children).toHaveLength(1);
  });

  it("an <input> that is not a checkbox is dropped; a checkbox stays, disabled", () => {
    const tree: Root = { type: "root", children: [el("input", { type: "text" }), el("input", { type: "checkbox", checked: true })] };
    rehypeSanitizeRaw()(tree);
    expect(tree.children).toHaveLength(1);
    expect((tree.children[0] as Element).properties).toMatchObject({ type: "checkbox", disabled: true });
  });

  it("only the style attribute is checked for CSS loads", () => {
    const p = clean(el("span", { title: "see url(x) and position: fixed", style: "color: red" })).properties;
    expect(p.title).toBe("see url(x) and position: fixed");
    expect(p.style).toBe("color: red");
  });
});
