/**
 * Plan W4.15 — src/lib/contentFrame.ts: the request round-trips through the
 * URL fragment (nothing of it in the part a server sees), the sandbox per
 * kind, the attributes of the frame and the size it reports.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  __setContentFrameUrl,
  applyContentFrameSize,
  contentFrameOrigin,
  contentFrameRequest,
  contentFrameSandbox,
  contentFrameSrc,
  createContentFrame,
  CONTENT_FRAME_PATH,
  type ContentFrameRequest,
} from "../lib/contentFrame";

/** The content frame's own site (plan W6.40), as a deployment sets it. */
const FRAME = "https://frame.example.org";

afterEach(() => {
  __setContentFrameUrl(undefined);
  document.body.replaceChildren();
});

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

  it("is null for an unknown kind, a source that is not https:, or fields of the wrong type (blind tests, F-6)", () => {
    const frag = (o: unknown) => `${CONTENT_FRAME_PATH}#${encodeURIComponent(JSON.stringify(o))}`;
    for (const bad of [
      { kind: "nope" },
      { kind: "nope", src: "https://img.example.com/a.png" },
      { kind: "img", src: "javascript:alert(1)" },
      { kind: "img", src: "http://img.example.com/a.png" },
      { kind: "img", src: "blob:https://app.example/1" },
      { kind: "img", src: "https://img.example.com/a.png", srcset: "data:image/png;base64,AA 2x" },
      { kind: "video", src: "data:text/html,<script>alert(1)</script>" },
      { kind: "audio", src: "https://media.example.com/a.mp3", loop: "yes" },
      { kind: "embed", src: "javascript:alert(document.domain)", title: "x" },
      { kind: "embed", src: "http://www.youtube.com/embed/x", title: "x" },
      { kind: "embed", src: "https://www.youtube.com/embed/x" },
      { kind: "embed", src: "https://www.youtube.com/embed/x", title: "x", referrerPolicy: "unsafe-url" },
      { kind: "gist", user: "a/b", id: "1" },
      ["img"],
      null,
    ]) {
      expect(contentFrameRequest(frag(bad)), JSON.stringify(bad)).toBeNull();
    }
    // Unknown fields are dropped from a valid request.
    expect(contentFrameRequest(frag({ kind: "audio", src: "https://media.example.com/a.mp3", onload: "x" }))).toEqual({ kind: "audio", src: "https://media.example.com/a.mp3" });
  });

  it("images, media and Gists are opaque; an embed keeps an origin only on the frame site (W6.40)", () => {
    for (const site of [null, FRAME]) {
      for (const k of ["img", "video", "audio", "gist"] as const) expect(contentFrameSandbox(k, site)!.split(" "), k).not.toContain("allow-same-origin");
      expect(contentFrameSandbox("img", site)).toBe("allow-scripts");
      // The train gives content frames no allow-popups (review 6 of #451): a Gist stays opaque and popup-less.
        expect(contentFrameSandbox("gist", site)).toBe("allow-scripts");
    }
    // allow-same-origin there is the frame site's origin; on the app's host there is no embed frame at all.
    expect(contentFrameSandbox("embed", FRAME)).toBe("allow-scripts allow-same-origin allow-popups allow-presentation allow-forms");
    expect(contentFrameSandbox("embed", null)).toBeNull();
  });

  it("createContentFrame: attributes and a size from the frame's report", () => {
    const img = createContentFrame(reqs[0]) as HTMLIFrameElement;
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

    const fixed = createContentFrame({ kind: "img", src: "https://img.example.com/x.png", width: 100, height: 50 }) as HTMLIFrameElement;
    expect(fixed.style.width).toBe("100px");
    applyContentFrameSize(fixed, { width: 640, height: 480 });
    expect(fixed.style.width).toBe("100px");

    const gist = createContentFrame(reqs[4]) as HTMLIFrameElement;
    applyContentFrameSize(gist, { width: 500, height: 333.2 });
    expect(gist.style.height).toBe("333px");

    __setContentFrameUrl(FRAME);
    const embed = createContentFrame(reqs[3]) as HTMLIFrameElement;
    expect(embed.getAttribute("allow")).toBe("fullscreen");
    expect(embed.style.height).toBe("100%");
    applyContentFrameSize(embed, { width: 10, height: 10 });
    expect(embed.style.height).toBe("100%");
  });
  it("the frame site: an https: URL (http: on loopback only), never on the app's own origin (W6.40)", () => {
    const app = location.origin;
    for (const [v, want] of [
      [FRAME, FRAME],
      [`${FRAME}/`, FRAME],
      ["http://127.0.0.1:5173/content-frame.html", "http://127.0.0.1:5173"],
      ["http://frame.example.org/", null],
      [`${FRAME}/?x=1`, null],
      [`${FRAME}/#x`, null],
      ["javascript:alert(1)", null],
      ["", null],
      [`${app}/content-frame.html`, null],
    ] as const) {
      __setContentFrameUrl(v);
      expect(contentFrameOrigin(), v).toBe(want);
    }
  });

  it("on the frame site every kind loads from it and names the app as the one parent; the request still round-trips", () => {
    for (const [url, page] of [[FRAME, `${FRAME}/`], ["http://127.0.0.1:5173/content-frame.html", "http://127.0.0.1:5173/content-frame.html"]] as const) {
      __setContentFrameUrl(url);
      for (const req of reqs) {
        const src = contentFrameSrc(req);
        expect(src.startsWith(`${page}#`), req.kind).toBe(true);
        expect(JSON.parse(decodeURIComponent(src.slice(src.indexOf("#") + 1))).parent).toBe(location.origin);
        expect(contentFrameRequest(src)).toEqual(req);
      }
    }
    // Another page of that site is not the frame.
    __setContentFrameUrl(FRAME);
    expect(contentFrameRequest(`${FRAME}/other#${encodeURIComponent(JSON.stringify(reqs[2]))}`)).toBeNull();
  });

  it("without a frame site an embed is a link that opens the player, not a frame (W6.40)", () => {
    __setContentFrameUrl(null);
    const el = createContentFrame(reqs[3]);
    expect(el.tagName).toBe("A");
    const a = el as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("https://player.vimeo.com/video/1");
    expect(a.target).toBe("_blank");
    expect(a.rel).toBe("noopener noreferrer");
    expect(a.textContent).toContain("Vimeo");
  });

  it("a size message counts only from the frame's own window and the origin that frame has (W6.40)", () => {
    __setContentFrameUrl(FRAME);
    const embed = createContentFrame({ kind: "embed", src: "https://player.vimeo.com/video/1", title: "Vimeo" }) as HTMLIFrameElement;
    const img = createContentFrame(reqs[0]) as HTMLIFrameElement;
    document.body.append(embed, img);
    expect(embed.dataset.frameOrigin).toBe(FRAME);
    expect(img.dataset.frameOrigin).toBe("null");
    const send = (frame: HTMLIFrameElement, origin: string, width: number) =>
      window.dispatchEvent(new MessageEvent("message", { data: { type: "lumen-content-frame", width, height: width }, origin, source: frame.contentWindow }));
    // An opaque image frame posts with origin "null": a message claiming the app's or the frame site's origin is not it.
    send(img, location.origin, 300);
    send(img, FRAME, 300);
    expect(img.style.width).not.toBe("300px");
    send(img, "null", 320);
    expect(img.style.width).toBe("320px");
    // Nothing else may size a frame, whatever origin it claims.
    window.dispatchEvent(new MessageEvent("message", { data: { type: "lumen-content-frame", width: 400, height: 400 }, origin: "null", source: window }));
    expect(img.style.width).toBe("320px");
  });
});
