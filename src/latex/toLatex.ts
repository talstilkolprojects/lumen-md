/**
 * Academic LaTeX with Hebrew (plan W5.22): a note's Markdown tree (mdast,
 * from remark + GFM + math) as a LaTeX document that compiles with LuaLaTeX
 * or XeLaTeX.
 *
 * Hebrew: babel with `\babelprovide[import, main]{hebrew}` — under LuaLaTeX
 * with `bidi=basic` (what babel's maintainers recommend for right-to-left
 * text), under XeLaTeX with `bidi=default`. Polyglossia would need the
 * separate `bidi` package under XeLaTeX and has no LuaLaTeX bidi of its own;
 * babel works with both engines from one preamble. Every run of the other
 * script is wrapped in `\foreignlanguage{…}` so it gets its own direction,
 * font and hyphenation; math and code are always left to right.
 *
 * Citations: Pandoc's `[@key]`, `[@key, p. 33]`, `[@a; @b]` and `@key` (in
 * the text) become natbib's `\citep` / `\citet`; the reference list is
 * written by Lumen in APA (the W2.16 formatter), each entry in its own
 * language and direction — bibtex's styles would set an English entry right
 * to left in a Hebrew paper. references.bib goes along for other styles.
 */
import type { Root, RootContent, PhrasingContent, Table, List, Heading } from "mdast";

export interface LatexOptions {
  /** Document language: "he" (default when the text is mostly Hebrew) or "en". */
  lang: "he" | "en";
  title?: string;
  author?: string;
  date?: string;
  /** Citation keys that exist (the .bib); a `@word` that is not one stays text. */
  citeKeys?: ReadonlySet<string>;
  /** Image path as written → path inside the project (images/…), or null to drop it. */
  image?: (url: string) => string | null;
  /** Hebrew font, then Latin font (names fontspec finds); the preamble falls back to free fonts. */
  fonts?: { hebrew?: string; latin?: string };
}

const HEBREW = /[\u0590-\u05FF\uFB1D-\uFB4F]/;
const LATIN = /[A-Za-z\u00C0-\u024F]/;

/** LaTeX's special characters, escaped. */
export function escapeTex(s: string): string {
  return s.replace(/[\\{}$&#^_%~]/g, (c) => ({ "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}", $: "\\$", "&": "\\&", "#": "\\#", "^": "\\textasciicircum{}", _: "\\_", "%": "\\%", "~": "\\textasciitilde{}" })[c]!);
}

/**
 * Text in a paragraph of language `lang`: runs of the other script wrapped
 * in `\foreignlanguage`. A run spans the words of that script and the
 * spaces / punctuation between them, so "Machine Learning model" is one run.
 */
export function bidiText(text: string, lang: "he" | "en"): string {
  const other = lang === "he" ? LATIN : HEBREW;
  const name = lang === "he" ? "english" : "hebrew";
  const re = lang === "he" ? /[A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F0-9'’.,@/:\- ]*[A-Za-z\u00C0-\u024F0-9]|[A-Za-z\u00C0-\u024F]|\d+(?:[–\-:/.]\d+)+/g : /[\u0590-\u05FF\uFB1D-\uFB4F][\u0590-\u05FF\uFB1D-\uFB4F0-9'"״׳\-־ ]*[\u0590-\u05FF\uFB1D-\uFB4F]|[\u0590-\u05FF\uFB1D-\uFB4F]/g;
  // In Hebrew, a number range (1–20, 10:30, 12/11) is an LTR run too: bidi would print 20–1.
  if (!other.test(text) && !(lang === "he" && /\d[–\-:/.]\d/.test(text))) return escapeTex(text);
  let out = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    out += escapeTex(text.slice(last, m.index)) + `\\foreignlanguage{${name}}{${escapeTex(m[0])}}`;
    last = m.index! + m[0].length;
  }
  return out + escapeTex(text.slice(last));
}

/** Pandoc citations in a text run → natbib commands (keys that are not in the .bib stay text). */
function citations(text: string, lang: "he" | "en", keys: ReadonlySet<string> | undefined): string {
  const known = (k: string) => !keys || keys.has(k);
  const re = /\[((?:[^\]]*?)-?@[\w:.#$%&\-+?<>~/]+[^\]]*)\]|(^|[\s(\-\u05BE])@([\w][\w:.#$%&\-+?<>~/]*[\w])/g;
  let out = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    let tex: string | null = null;
    if (m[1] !== undefined) {
      // [see @a, p. 3; @b] → \citep[see][p.~3]{a,b} (natbib takes one pre / post note per command).
      const parts = m[1].split(";").map((p) => /^\s*(.*?)\s*(-?)@([\w:.#$%&\-+?<>~/]*[\w])\s*,?\s*(.*?)\s*$/.exec(p));
      if (parts.every((p) => p && known(p[3]))) {
        const one = (pre: string, post: string, ks: string) =>
          pre || post ? `\\citep[${escapeTex(pre)}][${escapeTex(post.replace(/\s+/g, "\u00a0")).replace(/\u00a0/g, "~")}]{${ks}}` : `\\citep{${ks}}`;
        // natbib has one pre and one post note per command: a locator on a
        // key that is not the last gets a command of its own.
        const inner = parts.slice(0, -1).some((p, i) => p![4] || (i > 0 && p![1])) || (parts.length > 1 && !!parts[parts.length - 1]![1]);
        tex = inner
          ? parts.map((p) => one(p![1], p![4], p![3])).join("; ")
          : one(parts[0]![1], parts[parts.length - 1]![4], parts.map((p) => p![3]).join(","));
      }
    } else if (known(m[3])) {
      tex = `${escapeTex(m[2])}\\citet{${m[3]}}`;
    }
    if (tex === null) continue;
    out += bidiText(text.slice(last, m.index), lang) + tex;
    last = m.index! + m[0].length;
  }
  return out + bidiText(text.slice(last), lang);
}

const SECTION = ["section", "subsection", "subsubsection", "paragraph", "subparagraph", "subparagraph"];

/** The document's language by its letters: more Hebrew than Latin → Hebrew. */
export function documentLang(markdown: string): "he" | "en" {
  const he = (markdown.match(/[\u0590-\u05FF]/g) ?? []).length;
  const la = (markdown.match(/[A-Za-z]/g) ?? []).length;
  return he > 0 && he >= la / 3 ? "he" : "en";
}

/** The body of the document (between \begin{document} and \end{document}). */
export function mdastToLatex(tree: Root, opts: LatexOptions): { body: string; title?: string } {
  const lang = opts.lang;
  const defs = new Map<string, RootContent[]>();
  for (const n of tree.children) if (n.type === "footnoteDefinition") defs.set(n.identifier, n.children as RootContent[]);
  let title = opts.title;
  let firstH1Used = false;

  const inline = (nodes: PhrasingContent[]): string => nodes.map(phrase).join("");
  function phrase(n: PhrasingContent): string {
    // remark-math's nodes (typed by mdast-util-math's augmentation, which this file does not rely on).
    const loose = n as unknown as { type: string; value?: string };
    if (loose.type === "inlineMath") {
      const v = loose.value ?? "";
      // `$ … $` around Hebrew prose is two dollar signs, not math.
      return HEBREW.test(v) ? citations(`$${v}$`, lang, opts.citeKeys) : `$${v}$`;
    }
    switch (n.type) {
      case "text":
        // [[Note|label]] → label, [[Note]] → Note: a paper has no vault to link into.
        return citations(n.value.replace(/\[\[([^\]|\n]*)\|([^\]\n]*)\]\]/g, "$2").replace(/\[\[([^\]\n]*)\]\]/g, "$1"), lang, opts.citeKeys);
      case "emphasis":
        return `\\emph{${inline(n.children)}}`;
      case "strong":
        return `\\textbf{${inline(n.children)}}`;
      case "delete":
        return inline(n.children);
      case "inlineCode":
        return `\\foreignlanguage{english}{\\texttt{${escapeTex(n.value)}}}`;
      case "break":
        return "\\\\\n";
      case "link": {
        const text = inline(n.children);
        if (/^(https?|mailto):/i.test(n.url)) return `\\href{${n.url.replace(/[\\#%{}~^&_$]/g, "\\$&")}}{${text}}`;
        return text; // a link into the vault has no target in a paper
      }
      case "image": {
        const path = opts.image?.(n.url) ?? null;
        return path ? `\\includegraphics[width=\\linewidth]{${path}}` : escapeTex(n.alt ?? "");
      }
      case "footnoteReference": {
        const def = defs.get(n.identifier);
        return def ? `\\footnote{${def.map(block).join(" ").trim()}}` : "";
      }
      case "html":
        return "";
      default:
        return "";
    }
  }

  function table(t: Table): string {
    const align = (t.align ?? []).map((a) => (a === "center" ? "c" : a === "right" ? "r" : a === "left" ? "l" : lang === "he" ? "r" : "l"));
    const cols = Math.max(align.length, ...t.children.map((r) => r.children.length));
    const spec = Array.from({ length: cols }, (_, i) => align[i] ?? (lang === "he" ? "r" : "l")).join(" | ");
    const rows = t.children.map((r, i) => r.children.map((c) => inline(c.children)).join(" & ") + " \\\\" + (i === 0 ? " \\hline" : ""));
    return `\\begin{center}\n\\begin{tabular}{| ${spec} |}\n\\hline\n${rows.join("\n")}\n\\hline\n\\end{tabular}\n\\end{center}`;
  }

  function list(l: List): string {
    const env = l.ordered ? "enumerate" : "itemize";
    const items = l.children.map((li) => {
      const mark = li.checked === true ? "[$\\boxtimes$] " : li.checked === false ? "[$\\square$] " : "";
      return `\\item${mark ? mark.replace(/^/, "") : " "}${li.children.map(block).join("\n").trim()}`;
    });
    return `\\begin{${env}}\n${items.join("\n")}\n\\end{${env}}`;
  }

  function heading(h: Heading): string {
    const text = inline(h.children);
    if (h.depth === 1 && !firstH1Used && !title) {
      firstH1Used = true;
      title = h.children.map((c) => ("value" in c ? c.value : "")).join("");
      return "";
    }
    return `\\${SECTION[Math.min(h.depth - (title && firstH1Used ? 2 : 1), 5)] ?? "section"}{${text}}`;
  }

  function block(n: RootContent): string {
    const loose = n as unknown as { type: string; value?: string };
    if (loose.type === "math") return `\\[\n${loose.value ?? ""}\n\\]`;
    switch (n.type) {
      case "paragraph":
        return inline(n.children);
      case "heading":
        return heading(n);
      case "blockquote":
        return `\\begin{quote}\n${n.children.map(block).join("\n\n")}\n\\end{quote}`;
      case "list":
        return list(n);
      case "code":
        // Code is English, left to right, verbatim.
        return `\\begin{otherlanguage}{english}\n\\begin{verbatim}\n${n.value}\n\\end{verbatim}\n\\end{otherlanguage}`;
      case "thematicBreak":
        return "\\bigskip\\noindent\\hfil\\rule{0.4\\linewidth}{0.4pt}\\hfil\\bigskip";
      case "table":
        return table(n);
      case "footnoteDefinition":
      case "definition":
      case "yaml":
      case "html":
        return "";
      default:
        return "children" in n ? (n.children as RootContent[]).map(block).join("\n") : "";
    }
  }

  const parts = tree.children.map(block).filter((s) => s.trim());
  return { body: parts.join("\n\n") + "\n", title };
}

/** The preamble and the document around `body`. */
export function latexDocument(body: string, opts: LatexOptions & { bibliography?: string }): string {
  const he = opts.lang === "he";
  const hebrewFonts = [opts.fonts?.hebrew, "Frank Ruhl Libre", "David Libre", "Noto Serif Hebrew", "FreeSerif"].filter(Boolean) as string[];
  const latinFonts = [opts.fonts?.latin, "Latin Modern Roman"].filter(Boolean) as string[];
  const pick = (cmd: string, fonts: string[]) =>
    fonts.slice(0, -1).reduceRight((acc, f) => `\\IfFontExistsTF{${f}}{${cmd}{${f}}}{${acc}}`, `${cmd}{${fonts[fonts.length - 1]}}`);
  const lines = [
    "% Lumen academic export (plan W5.22). Compile with:",
    "%   latexmk -lualatex main.tex      (recommended: babel's bidi=basic)",
    "%   latexmk -xelatex main.tex       (works too: babel's bidi=default)",
    "% Fonts: Frank Ruhl Libre / David Libre (SIL OFL) when installed, else FreeSerif.",
    "\\documentclass[11pt,a4paper]{article}",
    "\\usepackage{iftex}",
    "\\ifLuaTeX",
    "  \\usepackage[bidi=basic]{babel}",
    "\\else",
    "  \\usepackage[bidi=default]{babel}",
    "\\fi",
    he ? "\\babelprovide[import, main]{hebrew}" : "\\babelprovide[import, main]{english}",
    he ? "\\babelprovide[import]{english}" : "\\babelprovide[import]{hebrew}",
    "\\usepackage{fontspec}",
    pick("\\babelfont[hebrew]{rm}", hebrewFonts),
    pick("\\babelfont[english]{rm}", latinFonts),
    "\\usepackage{amsmath,amssymb}",
    "\\usepackage{graphicx}",
    "\\usepackage[numbers,sort&compress]{natbib}",
    "\\usepackage[hidelinks]{hyperref}",
    opts.title ? `\\title{${bidiText(opts.title, opts.lang)}}` : "",
    ...(opts.author ? [`\\author{${bidiText(opts.author, opts.lang)}}`] : []),
    `\\date{${opts.date ? bidiText(opts.date, opts.lang) : ""}}`,
    "\\begin{document}",
    opts.title ? "\\maketitle" : "",
    "",
    body.trimEnd(),
    "",
    opts.bibliography ?? "",
    "\\end{document}",
    "",
  ];
  return lines.filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
}
