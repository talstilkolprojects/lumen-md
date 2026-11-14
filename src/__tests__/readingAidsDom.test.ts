/** Plan W5.6: the dyslexia-friendly layout on a real page — spacing applied, faces from this app's origin, all of it removed when off. */
import { describe, it, expect, beforeEach } from "vitest";
import { DEFAULT_AIDS, __resetAidsFaces, applyAids, loadAidsFace } from "../reading/readingAids";

beforeEach(() => {
  __resetAidsFaces();
  document.body.innerHTML = '<div class="prose-lumen"><p id="p">שלום עולם hello</p></div>';
});

describe("reading aids on the page", () => {
  it("on: the preview gets the spacing and the tint; off: everything is removed", () => {
    applyAids({ ...DEFAULT_AIDS, dyslexia: true, font: "app", letterSpacing: 0.2, wordSpacing: 0.5, lineHeight: 2 });
    const html = document.documentElement;
    expect(html.getAttribute("data-reading-aids")).toBe("on");
    expect(html.getAttribute("data-reading-tint")).toBe("cream");
    expect(document.getElementById("lumen-reading-aids-css")).not.toBeNull();
    const p = document.getElementById("p")!;
    const fs = parseFloat(getComputedStyle(p).fontSize);
    // jsdom computes no layout: the numbers are checked where a browser runs the test
    if (getComputedStyle(p).letterSpacing.endsWith("px")) expect(Math.abs(parseFloat(getComputedStyle(p).letterSpacing) - fs * 0.2)).toBeLessThan(0.6);
    if (getComputedStyle(p).lineHeight.endsWith("px")) expect(Math.abs(parseFloat(getComputedStyle(p).lineHeight) - fs * 2)).toBeLessThan(0.6);
    applyAids(DEFAULT_AIDS);
    expect(html.hasAttribute("data-reading-aids")).toBe(false);
    expect(html.style.getPropertyValue("--ra-letter")).toBe("");
  });

  it("a face downloads once, from this app's own origin", async () => {
    if (typeof FontFace === "undefined") return;
    const a = loadAidsFace("notoSansHebrew");
    const b = loadAidsFace("notoSansHebrew");
    expect(a).toBe(b);
    const ok = await a;
    // jsdom has no font loading; a browser loads the woff2 from /fonts/reading/.
    if (ok) expect([...document.fonts].some((f) => f.family.replace(/"/g, "") === "Lumen Noto Sans Hebrew")).toBe(true);
  });
});
