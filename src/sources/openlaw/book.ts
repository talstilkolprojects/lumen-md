/**
 * The Open Book of Laws (ספר החוקים הפתוח) as an offline source for W7.5
 * (plan W11.H16): Israeli laws as Hebrew Wikisource edits them, from the
 * Hugging Face dataset gkour/israeli_law (5,942 pages, about 25M tokens,
 * CC BY-SA 4.0 with credit to Wikisource; research R2 §1.10). It is not an
 * official source, and every result says so.
 *
 *  - Rights: the laws themselves have no copyright (§6 of the Copyright Act,
 *    the Knesset source's right), but this edition is Wikisource's, so a text
 *    from it is kept as **cc-by-sa** with Wikisource's credit and a link to
 *    the page. Every stored text carries that tag in its frontmatter.
 *  - Download only when the user asks, at a pinned dataset revision (the pin
 *    is owed: Hugging Face is not reachable where this was written, so
 *    OPEN_LAW_REVISION is null and nothing is offered until it is set).
 *  - Lookups are local: "סעיף 12 לחוק החוזים (חלק כללי)" finds the law with
 *    the Knesset name matcher (W7.5 lawNames) and the section with
 *    lawSections, on the device.
 *
 * Supreme Court rulings (LevMuchnik/SupremeCourtOfIsrael: "OpenRAIL" with the
 * licence details missing) are **link only** until their terms are clear: a
 * case reference becomes a link and a title, never a copy of the text.
 */
import type { Rights } from "../open/rights";
import { matchLaw, type LawRecord } from "../knesset/lawNames";
import { lawSections, type Section } from "../knesset/store";

export const OPEN_LAW_DATASET = "gkour/israeli_law";
/** The Hub commit the corpus is downloaded at. Null: not pinned yet, so the source is not offered (owed, Mac). */
export const OPEN_LAW_REVISION: string | null = null;
export const OPEN_LAW_RIGHTS: Rights = "cc-by-sa";
export const OPEN_LAW_LICENSE = "CC-BY-SA-4.0";
export const OPEN_LAW_CREDIT = "ספר החוקים הפתוח — ויקיטקסט העברי (he.wikisource.org), ברישיון CC BY-SA 4.0. לא מקור רשמי.";
export const OPEN_LAW_DIR = "Sources/OpenLaw";

export interface OpenLawRow {
  title: string;
  text: string;
  url?: string;
}

export interface OpenLaw extends LawRecord {
  text: string;
  url: string;
}

const TITLE_FIELDS = ["title", "name", "page_title", "law_name"];
const TEXT_FIELDS = ["text", "content", "wikitext", "body"];

/**
 * Rows of the dataset as exported to JSON lines (one object per page). The
 * Hub's column names could not be read offline, so the common names are
 * accepted and anything else fails loudly with the fields it found.
 */
export function parseOpenLawRows(jsonl: string): OpenLawRow[] {
  return jsonl
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l, i) => {
      const o = JSON.parse(l) as Record<string, unknown>;
      const title = TITLE_FIELDS.map((k) => o[k]).find((v) => typeof v === "string") as string | undefined;
      const text = TEXT_FIELDS.map((k) => o[k]).find((v) => typeof v === "string") as string | undefined;
      if (!title || text === undefined) throw new Error(`israeli_law row ${i + 1}: no title/text among its fields (${Object.keys(o).join(", ")})`);
      return { title, text, url: typeof o.url === "string" ? o.url : undefined };
    });
}

/** The Wikisource page of a law (its title, spaces as underscores). */
export const wikisourceUrl = (title: string): string => `https://he.wikisource.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;

/**
 * Wikisource's law markup (the ח: templates) as plain text with one section
 * per line: {{ח:סעיף|12|כותרת}} → "12. כותרת", {{ח:תת|(א)}} → "(א)",
 * links → their text, bold/italic quotes, <ref> notes and other templates out.
 * Text that is already plain passes through.
 */
export function plainLawText(wikitext: string): string {
  let t = wikitext.replace(/<ref[^>]*\/>|<ref[^>]*>[\s\S]*?<\/ref>/g, "");
  t = t.replace(/\{\{\s*ח:סעיף\*?\s*\|\s*([^|}]+?)\s*(?:\|\s*([^|}]*?))?(?:\|[^}]*)?\}\}/g, (_, n: string, title?: string) => `\n${n}. ${title ?? ""}`.trimEnd() + " ");
  t = t.replace(/\{\{\s*ח:ת{2,4}\s*\|\s*([^|}]+?)\s*(?:\|[^}]*)?\}\}/g, "\n$1 ");
  t = t.replace(/\{\{[^{}]*\}\}/g, "");
  t = t.replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, "$1");
  t = t.replace(/'{2,}/g, "");
  return t
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export function buildCorpus(rows: readonly OpenLawRow[]): OpenLaw[] {
  return rows.map((r, i) => ({ id: i + 1, name: r.title, isBasicLaw: /^חוק[- ]יסוד/.test(r.title), text: plainLawText(r.text), url: r.url ?? wikisourceUrl(r.title) }));
}

export interface OpenLawHit {
  law: OpenLaw;
  section: Section | null;
  rights: Rights;
  credit: string;
  url: string;
}

const SECTION = /(?:^|\s)(?:סעיף|ס['׳]|סע['׳])\s*(\d{1,3}[א-ת]?)(?:\s*\([^)]*\))*(?=\s|$|,)/;

/** "סעיף 12 לחוק …", "חוק …, סעיף 12", "ס' 5 לחוק …": the law and, when given, its section. */
export function parseLawQuery(q: string): { law: string; section: string | null } {
  const m = SECTION.exec(q);
  if (!m) return { law: q.trim(), section: null };
  const law = (q.slice(0, m.index) + " " + q.slice(m.index + m[0].length))
    .replace(/^\s*(?:ל|של|ב)(?=חוק)/, "")
    .replace(/\s+(?:ל|של|ב)(?=חוק)/, " ")
    .replace(/[,،]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/,$/, "");
  return { law, section: m[1] };
}

export function lookupOpenLaw(query: string, corpus: readonly OpenLaw[]): OpenLawHit | null {
  const { law: name, section } = parseLawQuery(query);
  const match = matchLaw(name, corpus);
  if (!match) return null;
  const law = match.law as OpenLaw;
  const sec = section ? (lawSections(law.text).find((s) => s.number === section) ?? null) : null;
  if (section && !sec) return null;
  return { law, section: sec, rights: OPEN_LAW_RIGHTS, credit: OPEN_LAW_CREDIT, url: law.url };
}

/** The note a looked-up law or section is saved as: the text with its licence tag, credit and link. */
export function renderOpenLawNote(hit: OpenLawHit, retrieved: string): string {
  const title = hit.section ? `סעיף ${hit.section.number} ל${hit.law.name}` : hit.law.name;
  const body = hit.section ? `${hit.section.number}. ${hit.section.text}` : hit.law.text;
  const fm = [
    "---",
    `title: "${title.replace(/"/g, '\\"')}"`,
    `source: ${OPEN_LAW_DATASET}`,
    `url: ${hit.url}`,
    `rights: ${hit.rights}`,
    `license: ${OPEN_LAW_LICENSE}`,
    `credit: "${OPEN_LAW_CREDIT}"`,
    "official: false",
    `retrieved: ${retrieved}`,
    "---",
  ];
  return `${fm.join("\n")}\n\n# ${title}\n\n${body}\n\n> ${OPEN_LAW_CREDIT} [המקור בוויקיטקסט](${hit.url})\n`;
}

// ── Supreme Court rulings: link only ─────────────────────────────────────

export const VERDICTS_DATASET = "LevMuchnik/SupremeCourtOfIsrael";
export const VERDICT_RIGHTS: Rights = "link-only";

export interface VerdictLink {
  title: string;
  url: string;
  rights: Rights;
}

const CASE = /^\s*(בג["״]?ץ|ע["״]?א|רע["״]?א|ע["״]?פ|רע["״]?פ|דנ["״]?א|דנ["״]?פ|בש["״]?פ|עע["״]?מ|ע["״]?ע|בר["״]?ם)\s*(\d{1,6})\/(\d{2,4})\s*(.*)$/;

/** A case reference ("בג״ץ 6821/93 …") as a link to the court's site and a title; null when it is not one. */
export function verdictLink(ref: string): VerdictLink | null {
  const m = CASE.exec(ref.normalize("NFC"));
  if (!m) return null;
  const kind = m[1].replace(/["״]/, "״");
  const title = `${kind} ${m[2]}/${m[3]}${m[4] ? ` ${m[4].trim()}` : ""}`;
  return { title, url: "https://supreme.court.gov.il/", rights: VERDICT_RIGHTS };
}
