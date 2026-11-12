/**
 * Plan W4.15 — src/lib/contentFrame.ts: the request round-trips through the
 * URL fragment (nothing of it in the part a server sees), the sandbox per
 * kind, the attributes of the frame and the size it reports.
 */
import { describe, it, expect } from "vitest";
import {
  applyContentFrameSize,
  contentFrameRequest,
  contentFrameSandbox,
  contentFrameSrc,
  createContentFrame,
  CONTENT_FRAME_PATH,
  type ContentFrameRequest,
} from "../lib/contentFrame";

describe("src/lib/contentFrame.ts", () => {
  const reqs: ContentFrameRequest[] = [
    { kind: "img", src: "https://img.example.com/a b.png?x=1&y=ü#frag", alt: "שלום", srcset: "https://img.example.com/a@2x.png 2x" },
    { kind: "video", src: "https://media.example.com/v.mp4", loop: true, muted: false },
    { kind: "audio", src: "https://media.example.com/a.mp3" },
    { kind: "embed", src: "https://player.vimeo.com/video/1", title: "Vimeo", allow: "fullscreen", referrerPolicy: "no-referrer" },
    { kind: "gist", user: "someone", id: "abc123" },
  ];

  it.each(reqs.map((r) => [r.kind, r] as const))("%s: the request round-trips through the fragment", (_k, req) => {
    const src = contentFrameSrc(req);
    expect(src.startsWith(`${CONTENT_FRAME_PATH}#`)).toBe(true);
    // Nothing of the request is in the part a server sees.
    expect(src.slice(0, src.indexOf("#"))).toBe(CONTENT_FRAME_PATH);
    expect(contentFrameRequest(src)).toEqual(req);
    expect(contentFrameRequest(`https://app.example${src}`)).toEqual(req);
  });

  it("is not fooled by other URLs", () => {
    expect(contentFrameRequest("https://evil.example/x#%7B%7D")).toBeNull();
    expect(contentFrameRequest(`${CONTENT_FRAME_PATH}#not-json`)).toBeNull();
    expect(contentFrameRequest(CONTENT_FRAME_PATH)).toBeNull();
  });

  it("only embeds keep the app's origin; images, media and Gists are opaque", () => {
    for (const k of ["img", "video", "audio", "gist"] as const) expect(contentFrameSandbox(k).split(" "), k).not.toContain("allow-same-origin");
    expect(contentFrameSandbox("img")).toBe("allow-scripts");
    expect(contentFrameSandbox("gist")).toBe("allow-scripts");
    expect(contentFrameSandbox("embed")).toBe("allow-scripts allow-same-origin allow-presentation allow-forms");
  });

  it("createContentFrame: attributes and a size from the frame's report", () => {
    const img = createContentFrame(reqs[0]);
    expect(img.getAttribute("sandbox")).toBe("allow-scripts");
    expect(img.dataset.contentFrame).toBe("img");
    expect(img.title).toBe("שלום");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(contentFrameRequest(img.getAttribute("src")!)).toEqual(reqs[0]);
    applyContentFrameSize(img, { width: 640, height: 480 });
    expect(img.style.width).toBe("640px");
    expect(img.style.height).toBe("auto");
    // Junk is ignored.
    applyContentFrameSize(img, { width: "1e9", height: -1 });
    expect(img.style.width).toBe("640px");

    const fixed = createContentFrame({ kind: "img", src: "https://img.example.com/x.png", width: 100, height: 50 });
    expect(fixed.style.width).toBe("100px");
    applyContentFrameSize(fixed, { width: 640, height: 480 });
    expect(fixed.style.width).toBe("100px");

    const gist = createContentFrame(reqs[4]);
    applyContentFrameSize(gist, { width: 500, height: 333.2 });
    expect(gist.style.height).toBe("333px");

    const embed = createContentFrame(reqs[3]);
    expect(embed.getAttribute("allow")).toBe("fullscreen");
    expect(embed.style.height).toBe("100%");
    applyContentFrameSize(embed, { width: 10, height: 10 });
    expect(embed.style.height).toBe("100%");
  });
});
