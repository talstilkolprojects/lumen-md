/**
 * Blind tests (plan W6.15, lane B): the content frame in a real DOM (#444).
 *
 * Written from the spec only (PR #444's body and the public API of
 * src/lib/contentFrame.ts, declarations without function bodies). The test list
 * (C8, C9) was written before any implementation was read; the implementation was then
 * opened only to check the import path.
 */
import { describe, expect, it } from "vitest";
import {
  CONTENT_FRAME_PATH,
  applyContentFrameSize,
  contentFrameRequest,
  contentFrameSandbox,
  createContentFrame,
  type ContentFrameRequest,
} from "../../lib/contentFrame";

const reqs: ContentFrameRequest[] = [
  { kind: "img", src: "https://img.example/a.png", alt: "שלום", width: 40, height: 30 },
  { kind: "video", src: "https://media.example/v.mp4" },
  { kind: "embed", src: "https://www.youtube-nocookie.com/embed/abc", title: "YouTube" },
  { kind: "gist", user: "octocat", id: "6cad326836d38bd3a7ae" },
];

describe("createContentFrame (C9)", () => {
  for (const req of reqs) {
    it(`${req.kind}: an iframe on the content frame page, with the kind's sandbox`, () => {
      const f = createContentFrame(req, document);
      expect(f.tagName).toBe("IFRAME");
      const src = f.getAttribute("src") ?? "";
      expect(new URL(src, location.href).pathname).toBe(CONTENT_FRAME_PATH);
      expect(contentFrameRequest(src)).toEqual(req);
      expect(f.getAttribute("sandbox")).toBe(contentFrameSandbox(req.kind));
      expect(f.hasAttribute("srcdoc")).toBe(false);
    });
  }
});

describe("applyContentFrameSize (C8)", () => {
  it("applies a reported size, and ignores what is not a size", () => {
    const f = createContentFrame(reqs[0], document);
    document.body.append(f);
    applyContentFrameSize(f, { width: 320, height: 40 });
    const shown = () => `${f.getAttribute("style") ?? ""}|${f.getAttribute("width") ?? ""}|${f.getAttribute("height") ?? ""}`;
    expect(shown()).toContain("40");
    const good = shown();
    for (const data of [{ height: "40px;background:url(https://evil.example/x)" }, { height: Number.NaN }, { height: -5 }, { height: { toString: () => "1;x" } }, { height: "expression(alert(1))" }, { width: "100%;position:fixed" }]) {
      applyContentFrameSize(f, data);
      expect(shown()).not.toMatch(/url\(|expression|NaN|-5|fixed/);
    }
    expect(shown()).toBe(good);
    f.remove();
  });
});
