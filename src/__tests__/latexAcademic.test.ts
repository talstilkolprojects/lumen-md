/**
 * Academic LaTeX with Hebrew (plan W5.22): ten golden documents (Hebrew,
 * English, mixed runs, inline and display math, citations, lists, a table,
 * footnotes, code and special characters) give exactly the .tex in
 * fixtures/latex; all ten compile with XeLaTeX (0 errors, 0 missing
 * characters — see docs/src/content/docs/workspace/latex-export.md).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { Root } from "mdast";
import { bidiText, documentLang, escapeTex } from "../latex/toLatex";
import { bibliographyTex, citedEntries, latexProject } from "../latex/project";
import { parseBibtex } from "../data/bibtex";

const dir = join(__dirname, "fixtures", "latex");
const parse = (md: string) => unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(md) as Root;
const bib = readFileSync(join(dir, "references.bib"), "utf8");
const docs = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();

describe("LaTeX golden documents (W5.22)", () => {
  it("has ten", () => expect(docs).toHaveLength(10));
  for (const f of docs) {
    it(f, async () => {
      const r = await latexProject({ markdown: readFileSync(join(dir, f), "utf8"), parse, bib });
      expect(r.tex).toBe(readFileSync(join(dir, f.replace(/\.md$/, ".tex")), "utf8"));
      expect(r.missingKeys).toEqual([]);
      expect(r.files.map((x) => x.name)).toContain("main.tex");
    });
  }
});

describe("Hebrew and English in one paragraph (W5.22)", () => {
  it("wraps runs of the other script, keeps number ranges left to right", () => {
    expect(bidiText("מודל Machine Learning גדול", "he")).toBe("מודל \\foreignlanguage{english}{Machine Learning} גדול");
    expect(bidiText("עמודים 1–20", "he")).toBe("עמודים \\foreignlanguage{english}{1–20}");
    expect(bidiText("a Hebrew phrase: שלום עולם.", "en")).toBe("a Hebrew phrase: \\foreignlanguage{hebrew}{שלום עולם}.");
    expect(bidiText("plain", "en")).toBe("plain");
  });
  it("escapes LaTeX's special characters", () => {
    expect(escapeTex("50% & #1 $x_y^2 ~{}\\")).toBe("50\\% \\& \\#1 \\$x\\_y\\textasciicircum{}2 \\textasciitilde{}\\{\\}\\textbackslash{}");
  });
  it("decides the document language by its letters", () => {
    expect(documentLang("שלום עולם with a few English words")).toBe("he");
    expect(documentLang("An English paper with שלום")).toBe("en");
  });
});

describe("citations: Pandoc [@key] → natbib, the list in APA by W2.16 (W5.22)", () => {
  it("cites known keys only; an e-mail address is not a citation", async () => {
    const r = await latexProject({ markdown: "כפי ש-@knuth1984 הראה [ראו @vaswani2017, עמ' 3; @cohen2020]. noa@example.com [@nokey]", parse, bib });
    expect(r.tex).toContain("\\citet{knuth1984}");
    // A locator on a key that is not the last: one command per key (natbib has one post note per command).
    expect(r.tex).toContain("\\citep[ראו][עמ'~3]{vaswani2017}; \\citep{cohen2020}");
    expect(r.tex).not.toContain("\\citep{nokey}");
    expect(r.tex).toContain("\\foreignlanguage{english}{noa@example.com}");
  });
  it("lists only the cited entries, each in its own language", () => {
    const cited = citedEntries(bib, "\\citep{knuth1984}");
    expect(parseBibtex(cited).map((e) => e.key)).toEqual(["knuth1984"]);
    const list = bibliographyTex(parseBibtex(bib), "he");
    expect(list).toContain("\\bibitem[Knuth(1984)]{knuth1984} \\foreignlanguage{english}{Knuth, D. E. (1984). \\emph{The TeXbook}. Addison-Wesley.}");
    expect(list).toMatch(/\\bibitem\[כהן\(2020\)\]\{cohen2020\} כהן, נ\./);
  });
  it("puts the images the vault has in images/, and leaves out the rest", async () => {
    const r = await latexProject({ markdown: "![א](pics/a.png) ![ב](missing.png)", parse, readImage: async (u) => (u === "pics/a.png" ? new Uint8Array([1]) : null) });
    expect(r.files.map((f) => f.name)).toContain("images/img1.png");
    expect(r.tex).toContain("\\includegraphics[width=\\linewidth]{images/img1.png}");
    expect(r.tex).not.toContain("missing.png");
  });
});
