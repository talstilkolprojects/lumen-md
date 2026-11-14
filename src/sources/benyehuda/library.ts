/**
 * Project Ben-Yehuda, offline (plan W7.7): Hebrew literature in the public
 * domain, searched and quoted with no network once downloaded.
 *
 * Source: the project's own dump of PUBLIC-DOMAIN works only,
 * github.com/projectbenyehuda/public_domain_dump (README and LICENSE: "All
 * these works are in the public domain, so you are free to make any use of
 * them"; credit, if given, as "Project Ben-Yehuda volunteers" with a link to
 * benyehuda.org). Works published on the site with their authors'
 * permission are not in the dump, so they never reach Lumen. The dump's
 * `pseudocatalogue.csv` lists every work (ID, path, title, authors,
 * translators, genre): the index admits only works in that list.
 *
 *  - Download, only when the user asks: the catalogue, then the texts of the
 *    authors the user picks, from raw.githubusercontent.com (one file per
 *    work, `txt/<path>.txt`), through the gated, ledgered fetch.
 *  - Each work is saved as a note in `Sources/BenYehuda/<author>/`, with
 *    its source, link, retrieval date and rights in the frontmatter, so it
 *    opens in the editor's reading view and its ==highlights== are notes.
 *  - Search: BM25 (plan 5.2) with Hebrew morphology and full/defective
 *    spelling (W2.11) over the title and author, and the text of every
 *    downloaded work. Niqqud is ignored for search and kept for reading.
 */

import { Bm25Index } from "../../search/bm25";
import { parseCsv } from "../datagov/snapshot";

/**
 * The dump at a fixed commit (review 20, RR20-5): files at a commit can't change, and the catalogue
 * is checked against its SHA-256, so the "public domain only" list is the project's, not whatever a
 * synced vault or a moved branch holds. VERSION 2026-03. Moving to a newer dump means updating both.
 */
export const DUMP_COMMIT = "5e4277fead7b565f32cc4b352abd3565023a77d8";
export const CATALOGUE_SHA256 = "f8ffb60fd9b770371a3060fedd746dce73a637aa2e2da1fb22b7165a05ea1e40";
/** Size limits: the catalogue is ~5 MB, the largest works a few MB. */
export const MAX_CATALOGUE_BYTES = 16 * 1024 * 1024;
export const MAX_WORK_BYTES = 8 * 1024 * 1024;
export const DUMP = `https://raw.githubusercontent.com/projectbenyehuda/public_domain_dump/${DUMP_COMMIT}/`;
export const CATALOGUE_URL = `${DUMP}pseudocatalogue.csv`;
export const LIBRARY_DIR = "Sources/BenYehuda";
export const CATALOGUE_PATH = `${LIBRARY_DIR}/pseudocatalogue.csv`;
export const CREDIT = "Project Ben-Yehuda volunteers";
export const CREDIT_HE = "מתנדבי פרויקט בן־יהודה";

export interface Work {
  id: number;
  /** "/p89/m4387" */
  path: string;
  /** As the catalogue writes it, niqqud included. */
  title: string;
  authors: string;
  translators: string;
  /** "poetry", "prose", "article"… (the catalogue's "Translation missing: he.poetry" reduced). */
  genre: string;
}

const POINTS = /[֑-ׇ]/g;
export const plain = (s: string) => s.replace(POINTS, "").replace(/[־]/g, "-");

export function parseCatalogue(csv: string): Work[] {
  const { header, rows } = parseCsv(csv);
  const at = (name: string) => header.indexOf(name);
  const [iId, iPath, iTitle, iAuthors, iTrans, iGenre] = ["ID", "path", "title", "authors", "translators", "genre"].map(at);
  if (iId < 0 || iPath < 0 || iTitle < 0) return [];
  const out: Work[] = [];
  for (const r of rows) {
    const id = Number(r[iId]);
    if (!Number.isInteger(id) || !/^\/p\d+\/m\d+$/.test(r[iPath] ?? "")) continue;
    out.push({ id, path: r[iPath], title: (r[iTitle] ?? "").trim(), authors: (r[iAuthors] ?? "").trim(), translators: (r[iTrans] ?? "").trim(), genre: (r[iGenre] ?? "").replace(/^Translation missing: he\./, "").trim() });
  }
  return out;
}

/** The text of a work in the dump (with niqqud, as published). */
export const textUrl = (w: Pick<Work, "path">) => `${DUMP}txt${w.path}.txt`;
/** The work's page on the project's site. */
export const workUrl = (w: Pick<Work, "id">) => `https://benyehuda.org/read/${w.id}`;

const fileSafe = (s: string) => plain(s).replace(/[\\/:*?"<>|[\]#^]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "untitled";

export const workNotePath = (w: Work) => `${LIBRARY_DIR}/${fileSafe(w.authors.split(";")[0] || "anonymous")}/${fileSafe(w.title)} (${w.id}).md`;

/** A downloaded work as a note: frontmatter with source, link, date and rights, then the text. */
export function renderWorkNote(w: Work, text: string, retrieved: string): string {
  // Every catalogue field is JSON-quoted, and the heading kept on one line (review 20, RR20-3).
  const q = (s: string) => JSON.stringify(s);
  return [
    "---",
    "type: source",
    "source: benyehuda",
    `id: ${w.id}`,
    `title: ${q(w.title)}`,
    `author: ${q(w.authors)}`,
    ...(w.translators ? [`translator: ${q(w.translators)}`] : []),
    ...(w.genre ? [`genre: ${q(w.genre)}`] : []),
    `url: ${workUrl(w)}`,
    `retrieved: ${retrieved}`,
    "rights: public-domain",
    `credit: ${q(CREDIT)}`,
    "---",
    "",
    `# ${oneLine(w.title)}`,
    "",
    creditLine(w),
    "",
    text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
    "",
  ].join("\n");
}

const oneLine = (s: string) => s.replace(/[\r\n\u2028\u2029]+/g, " ").trim();

/** Author, work, rights and credit as a line of the body, so an export keeps them (review 20, RR20-6). */
export function creditLine(w: Work): string {
  return `${CREDIT_LINE_PREFIX}${oneLine(w.authors)}, ״[${oneLine(plain(w.title))}](${workUrl(w)})״ · רשות הציבור · ${CREDIT_HE}`;
}
const CREDIT_LINE_PREFIX = "מקור: פרויקט בן־יהודה · ";

/** A saved work's id and text (the body after the title), or null for another note. */
export function parseWorkNote(md: string): { id: number; text: string } | null {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(md);
  if (!m || !/^source: benyehuda$/m.test(m[1])) return null;
  const id = Number(/^id: (\d+)$/m.exec(m[1])?.[1]);
  if (!Number.isInteger(id)) return null;
  const body = m[2].replace(/^\s*# .*\n/, "").replace(/^\s*\n?/, "");
  const lines = body.split("\n");
  if (lines[0]?.startsWith(CREDIT_LINE_PREFIX)) lines.shift();
  return { id, text: lines.join("\n").trim() };
}

/**
 * Only public-domain works: the ids in the dump's catalogue. Anything else
 * (a hand-made note claiming to be from the project, a work of an author
 * still in copyright) is left out of the index.
 */
export function publicDomainOnly<T extends { id: number }>(items: readonly T[], catalogue: readonly Work[]): T[] {
  const ids = new Set(catalogue.map((w) => w.id));
  return items.filter((i) => ids.has(i.id));
}

export interface Hit {
  work: Work;
  score: number;
  /** A line of the text that holds the query words (empty for a title-only match). */
  snippet: string;
  downloaded: boolean;
}

export class Library {
  private index = new Bm25Index();
  private works = new Map<number, Work>();
  private texts = new Map<number, string>();

  constructor(catalogue: readonly Work[], texts: ReadonlyArray<{ id: number; text: string }> = []) {
    for (const w of catalogue) this.works.set(w.id, w);
    for (const t of publicDomainOnly(texts, catalogue)) this.texts.set(t.id, t.text);
    for (const w of catalogue) this.index.set(String(w.id), plain(this.texts.get(w.id) ?? ""), plain(`${w.title} ${w.authors} ${w.translators}`));
  }

  get size(): number {
    return this.works.size;
  }

  has(id: number): boolean {
    return this.works.has(id);
  }

  search(query: string, limit = 10): Hit[] {
    return this.index.search(plain(query), { limit }).map((h) => {
      const work = this.works.get(Number(h.id))!;
      const text = this.texts.get(work.id) ?? "";
      return { work, score: h.score, snippet: snippetOf(text, query), downloaded: this.texts.has(work.id) };
    });
  }
}

function snippetOf(text: string, query: string): string {
  if (!text) return "";
  const words = plain(query).split(/\s+/).filter((w) => w.length > 1);
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  let best = "";
  let most = 0;
  for (const l of lines) {
    const n = words.filter((w) => plain(l).includes(w)).length;
    if (n > most) {
      most = n;
      best = l;
    }
  }
  return (best || lines[0] || "").slice(0, 160);
}

/**
 * The quote a passage becomes in a note: the words, the author and work, a
 * link to the work on the project's site, the public-domain mark and the
 * credit the project asks for.
 */
export function quoteBlock(w: Work, passage: string): string {
  const words = passage.trim().split("\n").map((l) => `> ${l.trim()}`);
  return [...words, ">", `> — ${w.authors}, ״[${w.title}](${workUrl(w)})״ · רשות הציבור · ${CREDIT_HE} ([benyehuda.org](https://benyehuda.org))`].join("\n");
}
