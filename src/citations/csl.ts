/**
 * CSL-JSON (the format Zotero, Zettlr and pandoc exchange) → the citation
 * record the 6.13 templates format (plan W2.16).
 */
import type { CitationRecord, Name } from "../data/citationStyles";

export interface CslName {
  family?: string;
  given?: string;
  suffix?: string;
  literal?: string;
  "non-dropping-particle"?: string;
  "dropping-particle"?: string;
}

export interface CslItem {
  id: string | number;
  type?: string;
  "citation-key"?: string;
  title?: string;
  author?: CslName[];
  editor?: CslName[];
  issued?: { "date-parts"?: Array<Array<number | string>>; raw?: string; literal?: string };
  "container-title"?: string;
  publisher?: string;
  volume?: string | number;
  issue?: string | number;
  page?: string;
  DOI?: string;
  URL?: string;
  edition?: string | number;
  language?: string;
  note?: string;
}

const TYPE: Record<string, CitationRecord["type"]> = {
  book: "book",
  "article-journal": "article",
  "article-magazine": "article",
  "article-newspaper": "article",
  article: "article",
  chapter: "chapter",
  "paper-conference": "chapter",
  "entry-encyclopedia": "chapter",
  thesis: "thesis",
  report: "report",
  webpage: "web",
  "post-weblog": "web",
};

export function cslName(n: CslName): Name {
  if (n.literal) return { family: n.literal };
  const particle = n["non-dropping-particle"] ? `${n["non-dropping-particle"]} ` : "";
  return { family: `${particle}${n.family ?? ""}`.trim(), given: [n.given, n["dropping-particle"]].filter(Boolean).join(" ") || undefined, suffix: n.suffix || undefined };
}

export function cslYear(item: CslItem): string | undefined {
  const dp = item.issued?.["date-parts"]?.[0]?.[0];
  if (dp !== undefined && dp !== "") return String(dp);
  const raw = item.issued?.raw ?? item.issued?.literal;
  return raw?.match(/\d{4}/)?.[0];
}

/** A Better BibTeX / Zotero 7 key kept in the note or extra field: "Citation Key: smith2020". */
export function keyFromNote(note?: string): string | undefined {
  return note?.match(/^\s*Citation Key:\s*(\S+)\s*$/im)?.[1];
}

export function cslToRecord(item: CslItem): CitationRecord {
  const english = !item.language || /^en\b/i.test(item.language);
  return {
    type: TYPE[item.type ?? ""] ?? "misc",
    authors: (item.author ?? []).map(cslName),
    editors: item.editor?.length ? item.editor.map(cslName) : undefined,
    year: cslYear(item),
    title: item.title ?? "",
    // Only English titles go into sentence case (APA); others stay as published.
    titleSentence: english ? undefined : item.title,
    container: item["container-title"] || undefined,
    publisher: item.publisher || undefined,
    volume: item.volume !== undefined ? String(item.volume) : undefined,
    issue: item.issue !== undefined ? String(item.issue) : undefined,
    pages: item.page?.replace(/\s*-{1,2}\s*/g, "–"),
    doi: item.DOI,
    url: item.URL,
    edition: item.edition !== undefined ? String(item.edition) : undefined,
  };
}
