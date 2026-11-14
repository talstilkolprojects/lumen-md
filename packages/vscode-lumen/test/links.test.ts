import { describe, it, expect } from "vitest";
import { classifyLink, findHeadingLine, slugifyHeading } from "../src/links";

describe("classifyLink decoding", () => {
  it("decodes reserved characters in file names, keeps malformed escapes raw", () => {
    expect(classifyLink("FAQ%231.md")).toEqual({ kind: "relative", path: "FAQ#1.md", fragment: "" });
    expect(classifyLink("what%3F.md#top")).toEqual({ kind: "relative", path: "what?.md", fragment: "top" });
    expect(classifyLink("bad%E0.md")).toEqual({ kind: "relative", path: "bad%E0.md", fragment: "" });
    expect(classifyLink("a%2Fb.md")).toEqual({ kind: "relative", path: "a%2Fb.md", fragment: "" });
  });
});

describe("classifyLink", () => {
  it("keeps in-page anchors in the webview", () => {
    expect(classifyLink("#install")).toEqual({ kind: "fragment" });
  });
  it("opens http(s)/mailto externally", () => {
    expect(classifyLink("https://example.com")).toEqual({ kind: "external", url: "https://example.com" });
    expect(classifyLink("mailto:a@b.c")).toEqual({ kind: "external", url: "mailto:a@b.c" });
  });
  it("resolves document-relative links, dropping query and keeping the fragment", () => {
    expect(classifyLink("next.md")).toEqual({ kind: "relative", path: "next.md", fragment: "" });
    expect(classifyLink("../docs/My%20Page.md?x=1#setup")).toEqual({
      kind: "relative",
      path: "../docs/My Page.md",
      fragment: "setup",
    });
    expect(classifyLink("/README.md")).toEqual({ kind: "relative", path: "/README.md", fragment: "" });
  });
  it("ignores other schemes and protocol-relative URLs", () => {
    for (const h of ["javascript:alert(1)", "command:workbench.action.quit", "file:///etc/passwd", "data:text/html,x", "//evil.test/x", ""]) {
      expect(classifyLink(h).kind, h).toBe("ignore");
    }
  });
});

describe("findHeadingLine", () => {
  const md = [
    "# Guide",
    "",
    "## Installation",
    "```sh",
    "## not a heading",
    "```",
    "## Installation",
    "### Über *Setup* (v2)",
  ].join("\n");
  it("finds headings by GitHub-style slug, with duplicate suffixes, skipping code", () => {
    expect(findHeadingLine(md, "installation")).toBe(2);
    expect(findHeadingLine(md, "installation-1")).toBe(6);
    expect(findHeadingLine(md, "not-a-heading")).toBe(-1);
    expect(findHeadingLine(md, encodeURIComponent("über-setup-v2"))).toBe(7);
    expect(findHeadingLine(md, "Guide")).toBe(0);
  });
  it("finds Setext headings and headings whose text is a link, like the preview's anchors", () => {
    const doc = ["Intro", "", "Setup", "-----", "", "# [Install](docs/install.md)", "", "Usage", "====="].join("\n");
    expect(findHeadingLine(doc, "setup")).toBe(2);
    expect(findHeadingLine(doc, "install")).toBe(5);
    expect(findHeadingLine(doc, "usage")).toBe(7);
  });
  it("slugifies like the preview", () => {
    expect(slugifyHeading("Hello, World!")).toBe("hello-world");
  });
});
