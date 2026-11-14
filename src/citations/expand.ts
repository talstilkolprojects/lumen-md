/**
 * `[@key]` in a note → formatted citations and a reference list (plan
 * W2.16), for the preview and for DOCX / PDF export. The style comes from
 * the frontmatter (`citation-style: apa | chicago | mla | il`, default
 * APA), the language from `lang:` or the note's direction. The list goes
 * where the note has pandoc's `::: {#refs}` block, else at the end. A key
 * the library doesn't know stays as written and is reported.
 */
import { markdownBaseDirection } from "../lib/textDirection";
import type { CitationLang, CitationRecord, Run } from "../data/citationStyles";
import { bibliography, formatCluster, yearSuffixes, type Style } from "./cite";
import { findCitations } from "./pandoc";

export interface ExpandOptions {
  style?: Style;
  lang?: CitationLang;
}

export interface Expanded {
  markdown: string;
  cited: string[];
  unknown: string[];
  style: Style;
  lang: CitationLang;
}

const HEAD = {
  en: { refs: "References", he: "Hebrew sources", other: "Sources in other languages" },
  he: { refs: "מקורות", he: "מקורות בעברית", other: "מקורות בשפות אחרות" },
} as const;

/** Does the text have anything that looks like a citation? (Cheap: decides whether to load this module.) */
export const mayHaveCitations = (md: string) => /(^|[\s([;—–"“'])-?@[\p{L}\p{N}_]/mu.test(md);

function frontmatter(md: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const out: Record<string, string> = {};
  for (const line of m?.[1].split(/\r?\n/) ?? []) {
    const kv = /^([\w-]+):\s*["']?(.*?)["']?\s*$/.exec(line);
    if (kv) out[kv[1].toLowerCase()] = kv[2];
  }
  return out;
}

const STYLE_ALIASES: Record<string, Style> = { apa: "apa", "apa-7": "apa", chicago: "chicago", "chicago-author-date": "chicago", mla: "mla", "mla-9": "mla", il: "il", "apa-il": "il", israeli: "il", "apa-he-il": "il" };

const esc = (s: string) => s.replace(/([\\*_[\]<>`])/g, "\\$1");
export const runsToSafeMarkdown = (runs: readonly Run[]) => runs.map((r) => (r.i ? `*${esc(r.t)}*` : esc(r.t))).join("");

export function expandCitations(md: string, lookup: (key: string) => CitationRecord | undefined, opts: ExpandOptions = {}): Expanded {
  const fm = frontmatter(md);
  const style: Style = opts.style ?? STYLE_ALIASES[(fm["citation-style"] ?? fm.csl ?? "").toLowerCase().replace(/\.csl$/, "")] ?? "apa";
  const lang: CitationLang = opts.lang ?? (/^he/i.test(fm.lang ?? "") ? "he" : /^en/i.test(fm.lang ?? "") ? "en" : markdownBaseDirection(md.replace(/^---[\s\S]*?---/, "")) === "rtl" ? "he" : "en");
  const clusters = findCitations(md);
  const cited: string[] = [];
  const unknown = new Set<string>();
  for (const c of clusters)
    for (const it of c.items) {
      if (!lookup(it.key)) unknown.add(it.key);
      else if (!cited.includes(it.key)) cited.push(it.key);
    }
  const records = cited.map((key) => ({ key, record: lookup(key)! }));
  const suffix = yearSuffixes(records, style);
  const ctx = { style, lang, lookup, suffix };
  let out = "";
  let at = 0;
  for (const c of clusters) {
    const original = md.slice(c.start, c.end);
    const f = formatCluster(c, ctx, original);
    out += md.slice(at, c.start) + (f === original ? original : esc(f));
    at = c.end;
  }
  out += md.slice(at);
  if (!records.length) return { markdown: out, cited, unknown: [...unknown], style, lang };
  const lists = bibliography(records, { style, lang, suffix });
  const H = HEAD[lang];
  const section =
    style === "il" && lists.length > 1
      ? [`## ${H.refs}`, "", `### ${H.he}`, "", ...lists[0].map((e) => runsToSafeMarkdown(e.runs) + "\n"), `### ${H.other}`, "", ...lists[1].map((e) => runsToSafeMarkdown(e.runs) + "\n")].join("\n")
      : [`## ${H.refs}`, "", ...lists.flat().map((e) => runsToSafeMarkdown(e.runs) + "\n")].join("\n");
  const refs = /^:::\s*\{#refs\}\s*\n(?:[\s\S]*?\n)?:::\s*$/m;
  const markdown = refs.test(out) ? out.replace(refs, section.trimEnd()) : `${out.replace(/\s*$/, "")}\n\n${section.trimEnd()}\n`;
  return { markdown, cited, unknown: [...unknown], style, lang };
}

/** The same with the vault's library (preview, export). */
export async function expandWithLibrary(md: string, opts: ExpandOptions = {}): Promise<Expanded> {
  const { loadLibrary } = await import("./library");
  const lib = await loadLibrary();
  const byKey = new Map(lib.map((x) => [x.key, x.record]));
  return expandCitations(md, (k) => byKey.get(k), opts);
}
