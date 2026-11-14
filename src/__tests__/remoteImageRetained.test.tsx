/**
 * #221 P1: a retained <img> whose src changes from a blocked other-site URL
 * to an allowed one must not render the old (blocked) URL even once —
 * that one commit would fire the tracking request without consent.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { createElement } from "react";
import { components } from "../renderer/components";
import { __resetRemoteImagesForTests, allowRemoteImageHosts } from "../lib/remoteImages";

const BLOCKED = "https://tracker.example.net/p.gif?u=42";
const ALLOWED = "https://ok.example.org/photo.png";

const seen: string[] = [];
const orig = Element.prototype.setAttribute;
beforeEach(() => {
  localStorage.clear();
  __resetRemoteImagesForTests();
  seen.length = 0;
  Element.prototype.setAttribute = function (name: string, value: string) {
    if (this.tagName === "IMG" && name === "src") seen.push(value);
    return orig.call(this, name, value);
  };
});
afterEach(() => {
  Element.prototype.setAttribute = orig;
});

describe("LumenImg on a src change", () => {
  it("never puts the previous blocked URL into an <img>", () => {
    allowRemoteImageHosts(["ok.example.org"]);
    const Img = components.img as unknown as (p: { src?: string; alt?: string }) => JSX.Element;
    const { container, rerender } = render(createElement(Img, { src: BLOCKED, alt: "a" }));
    expect(container.querySelector("img")).toBeNull();
    rerender(createElement(Img, { src: ALLOWED, alt: "a" }));
    expect(seen).not.toContain(BLOCKED);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(ALLOWED);
  });
});
