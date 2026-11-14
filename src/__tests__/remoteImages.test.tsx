/**
 * Plan 2.2 — images from other sites in notes wait for the user.
 *
 * The web CSP keeps `img-src https:` (a static policy cannot hold one user's
 * choices), so the renderer enforces the choice: no <img> for another site
 * reaches the DOM until "Load" or "Always allow". The e2e twin
 * (e2e/remote-images.spec.ts) counts the network requests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import { visit } from "unist-util-visit";
import type { Element, Root } from "hast";
import { Schema } from "@milkdown/prose/model";
import { renderMarkdown } from "../renderer/pipeline";
import { StaticRenderContext } from "../renderer/components";
import { rehypeSanitizeRaw } from "../renderer/rehypeSanitizeRaw";
import { RemoteImageView } from "../editor/remoteImageView";
import { contentFrameRequest } from "../lib/contentFrame";
import {
  ALLOWED_HOSTS_KEY,
  __resetRemoteImagesForTests,
  allowRemoteImageHosts,
  allowedRemoteImageHosts,
  forgetRemoteImageHost,
  loadRemoteImagesOnce,
  remoteImageAllowed,
  remoteImageGate,
  remoteImageHost,
  srcSetUrls,
} from "../lib/remoteImages";

const PIXEL = "https://tracker.example.net/p.gif?u=42";

beforeEach(() => {
  localStorage.clear();
  __resetRemoteImagesForTests();
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("remoteImageHost", () => {
  const base = "https://app.example.com/notes/a";
  it("is the host of an http(s) URL on another origin", () => {
    expect(remoteImageHost(PIXEL, base)).toBe("tracker.example.net");
    expect(remoteImageHost("http://Img.Example.org:8080/x.png", base)).toBe("img.example.org:8080");
    expect(remoteImageHost("//cdn.example.org/x.png", base)).toBe("cdn.example.org");
  });
  it("is null for the app's own files and inline data", () => {
    for (const src of ["./lumen-asset-1.png", "/x.png", "https://app.example.com/x.png", "data:image/png;base64,AAAA", "blob:https://app.example.com/1", "", "   ", null, undefined]) {
      expect(remoteImageHost(src, base), String(src)).toBeNull();
    }
    expect(remoteImageHost("javascript:alert(1)", base)).toBeNull();
  });
  it("reads srcset candidates", () => {
    expect(srcSetUrls("a.png 1x, https://x.example/b.png 2x,https://y.example/c.png 300w")).toEqual([
      "a.png",
      "https://x.example/b.png",
      "https://y.example/c.png",
    ]);
  });
});

describe("the allowlist", () => {
  it("blocks other sites until loaded once (this URL) or allowed (the host, persisted)", () => {
    expect(remoteImageAllowed(PIXEL)).toBe(false);
    expect(remoteImageAllowed("./local.png")).toBe(true);
    loadRemoteImagesOnce([PIXEL]);
    expect(remoteImageAllowed(PIXEL)).toBe(true);
    expect(remoteImageAllowed("https://tracker.example.net/other.gif")).toBe(false);
    expect(localStorage.getItem(ALLOWED_HOSTS_KEY)).toBeNull();

    allowRemoteImageHosts(["Tracker.Example.net"]);
    expect(remoteImageAllowed("https://tracker.example.net/other.gif")).toBe(true);
    expect(JSON.parse(localStorage.getItem(ALLOWED_HOSTS_KEY)!)).toEqual(["tracker.example.net"]);

    // A reload keeps the host but forgets "load once".
    __resetRemoteImagesForTests();
    expect(allowedRemoteImageHosts()).toEqual(["tracker.example.net"]);
    forgetRemoteImageHost("tracker.example.net");
    expect(remoteImageAllowed(PIXEL)).toBe(false);
  });

  it("survives unreadable storage", () => {
    localStorage.setItem(ALLOWED_HOSTS_KEY, "{not json");
    expect(allowedRemoteImageHosts()).toEqual([]);
    expect(remoteImageAllowed(PIXEL)).toBe(false);
  });

  it("the desktop app loads none (its CSP has no https: in img-src, plan 2.1)", () => {
    allowRemoteImageHosts(["tracker.example.net"]);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(remoteImageAllowed(PIXEL)).toBe(false);
    expect(remoteImageAllowed("./local.png")).toBe(true);
  });

  it("gates srcset: a blocked src blocks the image; an allowed one keeps only allowed candidates", () => {
    expect(remoteImageGate(PIXEL, "./a.png 1x").blocked).toBe(true);
    const g = remoteImageGate("./a.png", "./a.png 1x, https://cdn.example.org/b.png 2x");
    expect(g.blocked).toBe(false);
    expect(g.srcSet).toBe("./a.png 1x");
    expect(remoteImageGate(undefined, "https://cdn.example.org/b.png 2x").blocked).toBe(true);
    const all = remoteImageGate(PIXEL, "https://cdn.example.org/b.png 2x");
    expect(all.hosts).toEqual(["tracker.example.net", "cdn.example.org"]);
    expect(all.urls).toEqual([PIXEL, "https://cdn.example.org/b.png"]);
  });
});

/** What the content frames in `root` show (plan W4.15): [kind, src]. */
const framed = (root: ParentNode) =>
  [...root.querySelectorAll("iframe[data-content-frame]")].map((f) => {
    const req = contentFrameRequest(f.getAttribute("src") ?? "");
    return [req?.kind, req && "src" in req ? req.src : null];
  });

describe("in the preview", () => {
  const remoteImgs = (root: ParentNode) =>
    [...root.querySelectorAll("img")].filter((i) => remoteImageHost(i.getAttribute("src")) || /https?:/.test(i.getAttribute("srcset") ?? ""));

  it("a Markdown image from another site renders as the placeholder, no <img>", async () => {
    const tree = await renderMarkdown(`Hello ![pixel](${PIXEL}) and ![local](./lumen-asset-x.png)`, () => false);
    const { container } = render(tree);
    expect(remoteImgs(container)).toEqual([]);
    const ph = container.querySelector(".lumen-remote-image")!;
    expect(ph.getAttribute("data-remote-image")).toBe("tracker.example.net");
    expect(ph.textContent).toContain("pixel");
    expect(ph.textContent).toContain("tracker.example.net");
    // Inline, so it can sit in a paragraph.
    expect(ph.tagName).toBe("SPAN");
    expect(ph.closest("p")).not.toBeNull();
  });

  it("Load shows this image; Always allow shows every image of the host and is kept", async () => {
    const md = `![a](${PIXEL})\n\n![b](https://tracker.example.net/b.gif)`;
    const { container } = render(await renderMarkdown(md, () => false));
    expect(container.querySelectorAll(".lumen-remote-image")).toHaveLength(2);
    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: "Load" })[0]);
    });
    // Allowed: inside the content frame (plan W4.15), never an <img> in the app.
    await waitFor(() => expect(framed(container)).toEqual([["img", PIXEL]]));
    expect(remoteImgs(container)).toEqual([]);
    expect(container.querySelectorAll(".lumen-remote-image")).toHaveLength(1);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Always allow tracker.example.net" }));
    });
    expect(container.querySelectorAll(".lumen-remote-image")).toHaveLength(0);
    await waitFor(() => expect(framed(container)).toEqual([["img", PIXEL], ["img", "https://tracker.example.net/b.gif"]]));
    expect(remoteImgs(container)).toEqual([]);
    expect(JSON.parse(localStorage.getItem(ALLOWED_HOSTS_KEY)!)).toEqual(["tracker.example.net"]);
  });

  it("raw HTML <img> (and its srcset) is held back too", async () => {
    const { container } = render(
      await renderMarkdown(`<p><img src="${PIXEL}" srcset="https://cdn.example.org/2x.png 2x" alt="raw"></p>`, () => false),
    );
    expect(remoteImgs(container)).toEqual([]);
    expect(container.querySelector(".lumen-remote-image")!.getAttribute("data-remote-image")).toBe("tracker.example.net, cdn.example.org");
  });

  it("other-site <video> / <audio> are held back like images (WebKit ignores preload=none)", async () => {
    const md = `<video src="https://media.example.org/v.mp4" controls></video>\n\n<audio controls><source src="https://media.example.org/a.mp3" type="audio/mpeg"></audio>\n\n<video src="./lumen-asset-clip.mp4"></video>`;
    const { container } = render(await renderMarkdown(md, () => false));
    const phs = [...container.querySelectorAll(".lumen-remote-image")];
    expect(phs.map((p) => p.getAttribute("aria-label"))).toEqual(["Video or audio from media.example.org", "Video or audio from media.example.org"]);
    expect(phs.map((p) => p.querySelector(".lumen-remote-image-alt")!.textContent)).toEqual(["v.mp4", "a.mp3"]);
    // The local clip renders; no other-site media element or <source> exists.
    expect([...container.querySelectorAll("video, audio")].map((m) => m.getAttribute("src"))).toEqual(["./lumen-asset-clip.mp4"]);
    expect(container.querySelectorAll("source")).toHaveLength(0);
    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: "Always allow media.example.org" })[0]);
    });
    // Allowed: they play inside the content frame (plan W4.15); the local clip in the app.
    await waitFor(() =>
      expect(framed(container)).toEqual([
        ["video", "https://media.example.org/v.mp4"],
        ["audio", "https://media.example.org/a.mp3"],
      ]),
    );
    expect([...container.querySelectorAll("video, audio")].map((m) => m.getAttribute("src"))).toEqual(["./lumen-asset-clip.mp4"]);
  });

  it("on desktop the placeholder offers no Load (nothing could load)", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const { container } = render(await renderMarkdown(`![a](${PIXEL})`, () => false));
    expect(container.querySelector(".lumen-remote-image")!.textContent).toContain("desktop app");
    expect(container.querySelectorAll(".lumen-remote-image button")).toHaveLength(0);
  });

  it("HTML export keeps the real image (the file is for its readers, not a request from the app)", async () => {
    const tree = await renderMarkdown(`![a](${PIXEL})`, () => false);
    const html = renderToStaticMarkup(createElement(StaticRenderContext.Provider, { value: true }, tree));
    expect(html).toContain(`src="${PIXEL.replace("&", "&amp;")}"`);
    expect(html).not.toContain("lumen-remote-image");
  });
});

describe("rehypeSanitizeRaw: other-site loads nothing guards are removed", () => {
  async function tree(md: string): Promise<Root> {
    const p = unified().use(remarkParse).use(remarkRehype, { allowDangerousHtml: true }).use(rehypeRaw).use(rehypeSanitizeRaw);
    return (await p.run(p.parse(md))) as Root;
  }
  const find = (root: Root, tag: string) => {
    const out: Element[] = [];
    visit(root, "element", (n: Element) => {
      if (n.tagName === tag) out.push(n);
    });
    return out;
  };

  it("<picture><source srcset> from another site is dropped; the <img> stays for the placeholder", async () => {
    const t = await tree(`<picture><source srcset="https://cdn.example.org/a.webp" type="image/webp"><source srcset="./a.avif"><img src="${PIXEL}"></picture>`);
    const sources = find(t, "source");
    expect(sources[0].properties.srcSet).toBeUndefined();
    expect(String(sources[1].properties.srcSet)).toBe("./a.avif");
    expect(find(t, "img")[0].properties.src).toBe(PIXEL);
  });

  it("video / audio: no autoplay, preload none, no other-site poster", async () => {
    const t = await tree(`<video src="https://media.example.org/v.mp4" poster="https://media.example.org/p.jpg" autoplay controls></video>\n<audio src="https://media.example.org/a.mp3" autoplay preload="auto"></audio>`);
    const [video] = find(t, "video");
    const [audio] = find(t, "audio");
    expect(video.properties.poster).toBeUndefined();
    expect(video.properties.autoPlay).toBeUndefined();
    expect(video.properties.preload).toBe("none");
    expect(audio.properties.autoPlay).toBeUndefined();
    expect(audio.properties.preload).toBe("none");
  });

  it("media keep one other-site URL, their own src: the first <source src> is hoisted", async () => {
    const t = await tree(`<video controls><source src="https://media.example.org/a.webm"><source src="https://media.example.org/a.mp4"><source src="./a.mp4"><track src="https://media.example.org/subs.vtt"></video>`);
    const [video] = find(t, "video");
    expect(video.properties.src).toBe("https://media.example.org/a.webm");
    expect(find(t, "source").map((e) => e.properties.src)).toEqual(["./a.mp4"]);
    expect(find(t, "track")).toHaveLength(0);
  });

  it("SVG <image href>, the legacy background attribute; links keep their href", async () => {
    const t = await tree(
      `<svg><image href="${PIXEL}"></image><image href="#local"></image></svg>\n<table background="https://media.example.org/bg.png"><tr><td>x</td></tr></table>\n<a href="https://example.org/">link</a>`,
    );
    const images = find(t, "image");
    expect(images[0].properties.href).toBeUndefined();
    expect(images[1].properties.href).toBe("#local");
    expect(find(t, "table")[0].properties.background).toBeUndefined();
    expect(find(t, "a")[0].properties.href).toBe("https://example.org/");
  });
});

describe("WYSIWYG image node view", () => {
  // The commonmark preset's image node: inline atom with src / alt / title.
  const schema = new Schema({
    nodes: {
      doc: { content: "inline*" },
      text: { group: "inline" },
      image: { inline: true, group: "inline", atom: true, attrs: { src: { default: "" }, alt: { default: "" }, title: { default: "" } } },
    },
  });
  const node = (src: string, alt = "pic") => schema.nodes.image.create({ src, alt });

  it("renders the placeholder for another site and the content frame once allowed", () => {
    const view = new RemoteImageView(node(PIXEL));
    expect(view.dom.querySelector("img")).toBeNull();
    expect(view.dom.querySelector(".lumen-remote-image")!.textContent).toContain("tracker.example.net");
    const load = [...view.dom.querySelectorAll("button")].find((b) => b.textContent === "Load")!;
    expect(view.stopEvent({ target: load } as unknown as Event)).toBe(true);
    load.click();
    expect(view.dom.querySelector("img")).toBeNull();
    expect(framed(view.dom)).toEqual([["img", PIXEL]]);
    view.destroy();
  });

  it("local images render directly; update() follows the node", () => {
    const view = new RemoteImageView(node("./lumen-asset-1.png"));
    expect(view.dom.querySelector("img")!.getAttribute("src")).toBe("./lumen-asset-1.png");
    expect(view.update(node(PIXEL))).toBe(true);
    expect(view.dom.querySelector("img")).toBeNull();
    allowRemoteImageHosts(["tracker.example.net"]);
    expect(view.dom.querySelector("img")).toBeNull();
    expect(framed(view.dom)).toEqual([["img", PIXEL]]);
    view.destroy();
  });
});
