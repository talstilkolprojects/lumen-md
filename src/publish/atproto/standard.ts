/**
 * Standard.site records for a note (plan W7.19): the publication (the site)
 * and one document per published note, as the `site.standard.*` lexicons
 * describe them, plus what the static site (4.18) serves to prove it owns
 * them: `/.well-known/site.standard.publication` and a `<link>` per page.
 * Pure; the PDS calls are in ./client.
 */
import { plainText } from "../site";

export const PUBLICATION = "site.standard.publication";
export const DOCUMENT = "site.standard.document";

/** Frontmatter keys a published note keeps: where its record lives, so an update replaces it. */
export const DOC_KEY = "atproto-document";

export interface PublicationInput {
  name: string;
  /** The site's address (https://…), where the static site is served. */
  url: string;
  description?: string;
}

export function publicationRecord(p: PublicationInput): Record<string, unknown> {
  const url = p.url.trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^/\s]+/.test(url)) throw new Error("the site address must start with https://");
  return { $type: PUBLICATION, url, name: p.name.trim() || url, ...(p.description?.trim() ? { description: p.description.trim() } : {}) };
}

const SUMMARY = 300;

/** The note's summary: its frontmatter `description` / `summary`, else the start of its first paragraph. */
export function summaryOf(md: string, fm: Record<string, unknown> = {}): string {
  const own = fm.description ?? fm.summary;
  if (typeof own === "string" && own.trim()) return own.trim().slice(0, SUMMARY);
  const text = plainText(md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").replace(/^#{1,6}\s.*$/gm, ""));
  const first = text.split(/\n\s*\n/).map((s) => s.trim()).find(Boolean) ?? "";
  return first.length > SUMMARY ? first.slice(0, SUMMARY - 1).replace(/\s+\S*$/, "") + "…" : first;
}

export interface DocumentInput {
  /** at:// URI of the publication record. */
  site: string;
  /** The page's path on the site (`/Projects/Plan.html`). */
  path: string;
  title: string;
  markdown: string;
  fm?: Record<string, unknown>;
  /** BCP-47 language of the note (`he`, `en`). */
  lang: string;
  tags?: string[];
  publishedAt: string;
  updatedAt?: string;
}

const RTL = new Set(["he", "yi", "ar", "fa", "ur", "lad-Hebr"]);

/** The document record. Unknown fields are allowed by the AT Protocol, so the language and direction travel too. */
export function documentRecord(d: DocumentInput): Record<string, unknown> {
  const body = d.markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  const desc = summaryOf(d.markdown, d.fm);
  const lang = d.lang || "en";
  return {
    $type: DOCUMENT,
    site: d.site,
    path: d.path.startsWith("/") ? d.path : `/${d.path}`,
    title: d.title,
    ...(desc ? { description: desc } : {}),
    textContent: plainText(body).slice(0, 100_000),
    publishedAt: d.publishedAt,
    ...(d.updatedAt ? { updatedAt: d.updatedAt } : {}),
    ...(d.tags?.length ? { tags: d.tags.slice(0, 20) } : {}),
    langs: [lang],
    // Not part of the lexicon: readers that know it can set the page's direction.
    textDirection: RTL.has(lang) || RTL.has(lang.split("-")[0]) ? "rtl" : "ltr",
  };
}

export { documentLink, wellKnownPublication } from "./standardLinks";

const B32 = "234567abcdefghijklmnopqrstuvwxyz";

/** A TID record key (13 chars, sortable): microseconds since 1970 and a 10-bit clock id. */
export function tid(nowMs = Date.now(), clock = Math.floor(Math.random() * 1024)): string {
  let n = (BigInt(Math.floor(nowMs * 1000)) << 10n) | BigInt(clock & 1023);
  let s = "";
  for (let i = 0; i < 13; i++) {
    s = B32[Number(n & 31n)] + s;
    n >>= 5n;
  }
  return s;
}

/** at://did/collection/rkey → its parts, or null. */
export function parseAtUri(uri: string): { did: string; collection: string; rkey: string } | null {
  const m = /^at:\/\/(did:[a-z]+:[A-Za-z0-9._:%-]+)\/([a-zA-Z0-9.-]+)\/([A-Za-z0-9._~:-]{1,512})$/.exec(uri.trim());
  return m ? { did: m[1], collection: m[2], rkey: m[3] } : null;
}

export const atUri = (did: string, collection: string, rkey: string) => `at://${did}/${collection}/${rkey}`;
