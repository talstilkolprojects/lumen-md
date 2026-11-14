/**
 * CriticMarkup in the preview pipeline (suggesting mode).
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { extractToc, renderMarkdown, renderMarkdownFast } from "../renderer/pipeline";
import { prepareCriticMarkup, stripCriticDelimiters } from "../renderer/criticMarkup";
import { sanitizeHtmlMarkup } from "../lib/markupSanitizer";

const html = (md: string) => renderToStaticMarkup(renderMarkdownFast(md));

describe("CriticMarkup preview rendering", () => {
  it("renders all kinds as ins / del / mark with classes", () => {
    const out = html("a {++ins++} b {--del--} c {~~old~>new~~} d {>>note<<} e {==hl==}");
    expect(out).toContain('<ins class="critic-ins">ins</ins>');
    expect(out).toContain('<del class="critic-del">del</del>');
    expect(out).toContain('<del class="critic-del critic-sub-old">old</del><ins class="critic-ins critic-sub-new">new</ins>');
    expect(out).toContain('<mark class="critic-comment">note</mark>');
    expect(out).toContain('<mark class="critic-highlight">hl</mark>');
    expect(out).not.toMatch(/[-]/);
  });

  it("keeps inline markdown inside a suggestion", () => {
    const out = html("x {++a **bold** [link](https://e.x)++} y");
    expect(out).toContain('<ins class="critic-ins">a <strong>bold</strong> <a href="https://e.x">link</a></ins>');
  });

  it("substitutions are not eaten by GFM strikethrough", () => {
    const out = html("{~~one~>two~~}");
    expect(out).not.toContain("<del>one~&gt;two</del>");
    expect(out).toContain("critic-sub-new");
  });

  it("leaves markup in inline code and fenced code literal", () => {
    const out = html("`{++x++}`\n\n```\n{--y--}\n```\n");
    expect(out).toContain("<code>{++x++}</code>");
    expect(out).toContain("{--y--}");
    expect(out).not.toContain("critic-");
  });

  it("markup spanning paragraphs falls back to literal delimiters", () => {
    const out = html("{++first\n\nsecond++}");
    expect(out).not.toContain("<ins");
    expect(out).toContain("{++first");
    expect(out).toContain("second++}");
  });

  it("works inside headings, lists and tables", () => {
    const out = html("# Title {++new++}\n\n- item {--old--}\n\n| a |\n|---|\n| {==x==} |\n");
    // Blocks carry a `dir` since T25; the CriticMarkup inside is what matters here.
    expect(out).toMatch(/<h1 id="title-new"[^>]*>Title <ins class="critic-ins">new<\/ins><\/h1>/);
    expect(out).toMatch(/<li[^>]*>item <del class="critic-del">old<\/del><\/li>/);
    expect(out).toContain('<mark class="critic-highlight">x</mark>');
  });

  it("the full async pipeline renders it too", async () => {
    const tree = await renderMarkdown("x {++y++} `{--z--}`", () => false);
    const { container } = render(<div>{tree}</div>);
    expect(container.querySelector("ins.critic-ins")?.textContent).toBe("y");
    expect(container.querySelector("code")?.textContent).toBe("{--z--}");
  });

  it("documents without CriticMarkup are passed through unchanged", () => {
    const md = "plain ~~strike~~ text";
    expect(prepareCriticMarkup(md)).toBe(md);
    expect(html(md)).toContain("<del>strike</del>");
  });

  it("output survives the HTML sanitizer allowlist", () => {
    const out = html("{++a++}{--b--}{>>c<<}{==d==}");
    const clean = sanitizeHtmlMarkup(out);
    for (const tag of ['<ins class="critic-ins">', '<del class="critic-del">', '<mark class="critic-comment">', '<mark class="critic-highlight">']) {
      expect(clean).toContain(tag);
    }
  });

  it("raw HTML inside a suggestion still goes through the normal pipeline", async () => {
    const tree = await renderMarkdown('{++<span title="k">hi</span>++}', () => false);
    const { container } = render(<div>{tree}</div>);
    expect(container.querySelector("ins.critic-ins span[title=k]")?.textContent).toBe("hi");
  });
});

describe("TOC ids match rendered headings", () => {
  it("strips delimiters for slugs", () => {
    expect(stripCriticDelimiters("# A {++b++}")).toBe("# A b");
    expect(extractToc("# Title {++new++}")[0].id).toBe("title-new");
  });
});

describe("user-authored private-use characters", () => {
  const PUA = "";
  it("are preserved when the document has no suggestions", () => {
    const out = html(`Glyphs ${PUA} and \`code ${PUA}\``);
    expect(out).toContain(`Glyphs ${PUA}`);
    expect(out).toContain(`code ${PUA}`);
    expect(out).not.toContain("{++");
  });

  it("are preserved next to real suggestions", () => {
    const out = html(`a {++new++} b`);
    expect(out).toContain("a");
    expect(out).toContain("b");
    expect(out).toMatch(/<ins class="critic-ins">new<\/ins>/);
  });

  it("survive the TOC strip", () => {
    expect(stripCriticDelimiters(`# Hi  {++x++}`)).toBe(`# Hi  x`);
  });
});
