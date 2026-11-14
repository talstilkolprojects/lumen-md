/**
 * A LaTeX project from a note (plan W5.22): main.tex, references.bib (the
 * vault's BibTeX entries the note cites), the images it shows, and a README
 * with the compile command — one ZIP that compiles anywhere with TeX Live
 * or MiKTeX (or Tectonic). Pure apart from the injected parser and files.
 */
import type { Root } from "mdast";
import { parseBibtex, type BibEntry } from "../data/bibtex";
import { formatReference, parseNames, recordFromBibtex } from "../data/citationStyles";
import { zip, type ZipInput } from "../storage/zip";
import { bidiText, documentLang, escapeTex, latexDocument, mdastToLatex } from "./toLatex";

export interface LatexProjectInput {
  markdown: string;
  /** remark-parse + remark-gfm + remark-math. */
  parse: (markdown: string) => Root;
  /** Every .bib in the vault, concatenated. */
  bib?: string;
  /** An image the note shows, by the path written in it. */
  readImage?: (url: string) => Promise<Uint8Array | null>;
  title?: string;
  author?: string;
}

const FRONTMATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** The entries of `bib` that `tex` cites, as BibTeX text (whole entries, as written). */
export function citedEntries(bib: string, tex: string): string {
  const keys = new Set<string>();
  for (const m of tex.matchAll(/\\cite[pt]?(?:\[[^\]]*\])*\{([^}]*)\}/g)) for (const k of m[1].split(",")) keys.add(k.trim());
  const out: string[] = [];
  for (const m of bib.matchAll(/@(\w+)\s*\{\s*([^,\s]+)\s*,[\s\S]*?\n\s*\}\s*(?=@|$)/g)) if (keys.has(m[2])) out.push(m[0].trim());
  return out.length ? out.join("\n\n") + "\n" : "";
}

const HEBREW = /[\u0590-\u05FF]/;

/**
 * `thebibliography` for the cited entries, APA, sorted by first author and
 * year; an entry in the other language is set in that language (and
 * direction) as a whole.
 */
export function bibliographyTex(entries: BibEntry[], docLang: "he" | "en"): string {
  if (!entries.length) return "";
  const sorted = [...entries].sort((a, b) => (a.fields.author ?? "").localeCompare(b.fields.author ?? "", "he") || (a.fields.year ?? "").localeCompare(b.fields.year ?? ""));
  const items = sorted.map((raw) => {
    // BibTeX markup in values (`{\\TeX}book`, protected `{Capitals}`) is not text.
    const e: BibEntry = { ...raw, fields: Object.fromEntries(Object.entries(raw.fields).map(([k, v]) => [k, v.replace(/\\([A-Za-z]+)\s?/g, "$1").replace(/[{}]/g, "")])) };
    const lang = HEBREW.test(`${e.fields.title ?? ""}${e.fields.author ?? ""}`) ? "he" : "en";
    const text = formatReference(recordFromBibtex(e), "apa", lang)
      .map((r) => (r.i ? `\\emph{${bidiText(r.t, lang)}}` : bidiText(r.t, lang)))
      .join("");
    const surname = parseNames(e.fields.author ?? "")[0]?.family ?? e.key;
    const label = `${escapeTex(surname)}(${escapeTex(e.fields.year ?? "")})`;
    const body = lang === docLang ? text : `\\foreignlanguage{${lang === "he" ? "hebrew" : "english"}}{${text}}`;
    return `\\bibitem[${label}]{${e.key}} ${body}`;
  });
  return `\\begin{thebibliography}{${entries.length}}\n${items.join("\n\n")}\n\\end{thebibliography}`;
}

export async function latexProject(input: LatexProjectInput): Promise<{ files: ZipInput[]; tex: string; missingKeys: string[] }> {
  const fm = FRONTMATTER.exec(input.markdown);
  const md = fm ? input.markdown.slice(fm[0].length) : input.markdown;
  const fmTitle = fm ? /^title:\s*["']?(.+?)["']?\s*$/m.exec(fm[1])?.[1] : undefined;
  const fmAuthor = fm ? /^author:\s*["']?(.+?)["']?\s*$/m.exec(fm[1])?.[1] : undefined;
  const keys = new Set(parseBibtex(input.bib ?? "").map((e) => e.key));
  const lang = documentLang(md);
  const tree = input.parse(md);
  // Images first (the converter is synchronous): only the ones the vault has go in.
  const images = new Map<string, { path: string; bytes: Uint8Array }>();
  const walk = (n: { type: string; url?: string; children?: unknown[] }) => {
    if (n.type === "image" && n.url && !images.has(n.url)) images.set(n.url, { path: "", bytes: new Uint8Array() });
    for (const c of n.children ?? []) walk(c as typeof n);
  };
  walk(tree);
  let n = 0;
  for (const url of [...images.keys()]) {
    const ext = /\.(png|jpe?g|pdf)$/i.exec(url)?.[0].toLowerCase();
    const bytes = ext && !/^[a-z][a-z0-9+.-]*:/i.test(url) ? await input.readImage?.(url).catch(() => null) : null;
    if (bytes && ext) images.set(url, { path: `images/img${++n}${ext}`, bytes });
    else images.delete(url);
  }
  const opts = { lang, title: input.title ?? fmTitle, author: input.author ?? fmAuthor, citeKeys: keys, image: (url: string) => images.get(url)?.path ?? null };
  const { body, title } = mdastToLatex(tree, opts);
  const cited = citedEntries(input.bib ?? "", body);
  const tex = latexDocument(body, { ...opts, title, bibliography: bibliographyTex(parseBibtex(cited), lang) });
  const used = new Set<string>();
  for (const m of body.matchAll(/\\cite[pt]?(?:\[[^\]]*\])*\{([^}]*)\}/g)) for (const k of m[1].split(",")) used.add(k.trim());
  const readme =
    "Compile (TeX Live 2023+ or MiKTeX):\n  latexmk -lualatex main.tex\nor\n  latexmk -xelatex main.tex\n\nThe reference list is in main.tex (APA); references.bib holds the same entries for bibtex / biblatex styles.\n" +
    "Hebrew uses babel (bidi=basic under LuaLaTeX). Fonts: Frank Ruhl Libre or David Libre (SIL OFL, fonts.google.com) when installed, else FreeSerif.\n";
  const files: ZipInput[] = [
    { name: "main.tex", data: tex },
    ...(cited ? [{ name: "references.bib", data: cited }] : []),
    ...[...images.values()].map((im) => ({ name: im.path, data: im.bytes, store: true })),
    { name: "README.txt", data: readme },
  ];
  return { files, tex, missingKeys: [...used].filter((k) => !keys.has(k)) };
}

export const latexZip = (files: ZipInput[]) => zip(files);
