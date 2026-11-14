/**
 * Publish notes to the person's AT Protocol account as Standard.site
 * documents (plan W7.19), from the publish dialog. The publication record is
 * made once per site address and remembered on this device; each note
 * remembers its document in its frontmatter (`atproto-document:`), so
 * publishing it again replaces the same record, and "Remove" deletes it.
 * The Markdown note stays the source; the record is a copy.
 */
import { DOC_KEY, DOCUMENT, PUBLICATION, atUri, documentRecord, parseAtUri, publicationRecord, tid } from "./standard";
import { deleteRecord, putRecord, signIn, type Session } from "./client";
import { outputOf } from "../site";
import { encodePath, pageTitle } from "../siteLinks";
import { parseProperties, removeProperty, setProperty } from "../../properties/frontmatter";

const PUB_KEY = "lumen.atproto.publication";

export interface AtprotoTarget {
  handle: string;
  /** Typed this time (then kept in the secret store); null: the stored one. */
  password: string | null;
  siteUrl: string;
  siteName: string;
}

interface StoredPublication {
  did: string;
  url: string;
  uri: string;
}

function storedPublication(): StoredPublication | null {
  try {
    const raw = localStorage.getItem(PUB_KEY);
    return raw ? (JSON.parse(raw) as StoredPublication) : null;
  } catch {
    return null;
  }
}

function fmOf(md: string): Record<string, unknown> {
  return Object.fromEntries(parseProperties(md).properties.map((p) => [p.key, p.value]));
}

/** A note's language: its frontmatter `lang`, else Hebrew when Hebrew letters lead, else English. */
export function noteLang(md: string, fm: Record<string, unknown>): string {
  const own = fm.lang ?? fm.language;
  if (typeof own === "string" && /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(own.trim())) return own.trim();
  const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  const he = (body.match(/[\u0590-\u05FF]/g) ?? []).length;
  const latin = (body.match(/[A-Za-z]/g) ?? []).length;
  return he > latin ? "he" : "en";
}

async function publication(s: Session, t: AtprotoTarget): Promise<string> {
  const url = t.siteUrl.trim().replace(/\/+$/, "");
  const known = storedPublication();
  const record = publicationRecord({ name: t.siteName, url });
  const rkey = known && known.did === s.did && known.url === url ? (parseAtUri(known.uri)?.rkey ?? tid()) : tid();
  const uri = await putRecord(s, PUBLICATION, rkey, record);
  try {
    localStorage.setItem(PUB_KEY, JSON.stringify({ did: s.did, url, uri } satisfies StoredPublication));
  } catch {
    /* why: storage blocked — the next publish makes a new publication record */
  }
  return uri;
}

export interface PublishedNote {
  path: string;
  uri: string;
  /** The note's text with `atproto-document:` set. */
  content: string;
}

/** Publish each note; returns the publication URI and every note's document. */
export async function publishNotes(notes: ReadonlyArray<{ path: string; content: string }>, t: AtprotoTarget, now = new Date()): Promise<{ publication: string; notes: PublishedNote[] }> {
  const s = await signIn(t.handle, t.password);
  const pub = await publication(s, t);
  const out: PublishedNote[] = [];
  for (const n of notes) {
    const fm = fmOf(n.content);
    const prev = typeof fm[DOC_KEY] === "string" ? parseAtUri(fm[DOC_KEY] as string) : null;
    const rkey = prev && prev.did === s.did && prev.collection === DOCUMENT ? prev.rkey : tid(now.getTime());
    const published = typeof fm.published === "string" && !Number.isNaN(Date.parse(fm.published)) ? new Date(fm.published).toISOString() : now.toISOString();
    const tags = Array.isArray(fm.tags) ? fm.tags.map(String) : typeof fm.tags === "string" ? fm.tags.split(/[,\s]+/).filter(Boolean) : [];
    const record = documentRecord({
      site: pub,
      path: `/${encodePath(outputOf(n.path))}`,
      title: pageTitle(n.content, n.path),
      markdown: n.content,
      fm,
      lang: noteLang(n.content, fm),
      tags,
      publishedAt: published,
      ...(prev ? { updatedAt: now.toISOString() } : {}),
    });
    const uri = await putRecord(s, DOCUMENT, rkey, record);
    out.push({ path: n.path, uri, content: setProperty(n.content, DOC_KEY, uri) });
  }
  return { publication: pub, notes: out };
}

/** Delete each note's document record; returns the notes' texts without `atproto-document:`. */
export async function unpublishNotes(notes: ReadonlyArray<{ path: string; content: string }>, t: Pick<AtprotoTarget, "handle" | "password">): Promise<Array<{ path: string; content: string }>> {
  const s = await signIn(t.handle, t.password);
  const out: Array<{ path: string; content: string }> = [];
  for (const n of notes) {
    const uri = fmOf(n.content)[DOC_KEY];
    if (typeof uri !== "string") continue;
    await deleteRecord(s, uri);
    out.push({ path: n.path, content: removeProperty(n.content, DOC_KEY) });
  }
  return out;
}

/** The document URIs the chosen notes carry, for the site's `<link>` tags. */
export function documentsOf(notes: ReadonlyArray<{ path: string; content: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of notes) {
    const m = /^atproto-document:\s*"?(at:\/\/[^\s"]+)"?\s*$/m.exec(/^---\r?\n[\s\S]*?\r?\n---/.exec(n.content)?.[0] ?? "");
    if (m) out[n.path] = m[1];
  }
  return out;
}

export const publicationUri = (): string | null => storedPublication()?.uri ?? null;
export { atUri };
