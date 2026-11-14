/**
 * Publishing to the AT Protocol with Standard.site (plan W7.19), with no
 * server of ours: "Publish" on a note writes a `site.standard.document`
 * record (and once, a `site.standard.publication`) into the user's own PDS.
 * Bluesky shows rich previews of such links; Leaflet and other readers show
 * the document; Bridgy Fed bridges it to the fediverse for users who opt in.
 *
 * - Login: the user's handle and an App Password, typed for one sign-in and
 *   never stored. Only the refresh token is kept, in the secret store (2.5);
 *   the access token lives in memory.
 * - Every request is a user action (Publish, Update, Unpublish) and goes
 *   through the privacy ledger (`atprotoFetch`).
 * - The Markdown export stays the source: the record's `content` is the
 *   note's Markdown (`at.markpub.markdown`), and it is redacted HERE, inside
 *   `documentRecord`, so no caller can hand a raw note to a public, permanent
 *   record (review 20, RR20-587-1): `<redact>` passages, HTML comments and
 *   `%%…%%` comments are removed fail-closed, and #473's export door runs too
 *   when the build has it.
 * - Standard.site has no language or direction field: Hebrew text carries its
 *   own direction (the Unicode bidi algorithm), and the site page sets
 *   `lang`/`dir` on <html>. We don't invent a field.
 */

export const PUBLICATION_NSID = "site.standard.publication";
export const DOCUMENT_NSID = "site.standard.document";
export const MARKDOWN_TYPE = "at.markpub.markdown";
/** The only credential kept: the session's refresh token (the App Password is never stored). */
export const REFRESH_SECRET = "lumen.atproto.refreshJwt";
export const WELL_KNOWN_PATH = ".well-known/site.standard.publication";

export interface Publication {
  $type: typeof PUBLICATION_NSID;
  url: string;
  name: string;
  description?: string;
}

export interface StandardDocument {
  $type: typeof DOCUMENT_NSID;
  /** The publication's at:// URI (or the site's URL). */
  site: string;
  title: string;
  publishedAt: string;
  path?: string;
  description?: string;
  textContent?: string;
  content?: { $type: typeof MARKDOWN_TYPE; text: string };
  tags?: string[];
  updatedAt?: string;
}

export function publicationRecord(p: { url: string; name: string; description?: string }): Publication {
  const url = new URL(p.url);
  if (url.protocol !== "https:") throw new Error("A publication's URL must be https");
  return { $type: PUBLICATION_NSID, url: url.href.replace(/\/$/, ""), name: p.name.trim(), ...(p.description?.trim() ? { description: p.description.trim() } : {}) };
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Title: frontmatter `title`, else the first `# heading`, else the file name. */
export function noteTitle(md: string, path: string): string {
  const fm = FRONTMATTER.exec(md)?.[1] ?? "";
  const t = /^title:\s*["']?(.+?)["']?\s*$/m.exec(fm)?.[1] ?? /^#\s+(.+?)\s*#*\s*$/m.exec(md.replace(FRONTMATTER, ""))?.[1];
  return (t ?? path.split("/").pop()!.replace(/\.md$/i, "")).trim();
}

export const REDACTED = "█████";

/**
 * What a public record may never carry, removed fail-closed (the rules of
 * #473's export door): a `<redact>` passage (any case, attributes allowed,
 * nested passages counted; one never closed runs to the end of the note, and a
 * mark inside code counts too) becomes `█████`; an HTML comment is dropped (to
 * the end when never closed); `%%…%%` comments are dropped in pairs (a lone
 * `%%` stays: it is common in text).
 */
export function privateRemoved(md: string): string {
  const OPEN = /<redact\b[^>]*>/gi;
  const ANY = /<(\/?)redact\b[^>]*>/gi;
  let out = "";
  let at = 0;
  for (;;) {
    OPEN.lastIndex = at;
    const o = OPEN.exec(md);
    if (!o) break;
    out += md.slice(at, o.index) + REDACTED;
    let depth = 1;
    ANY.lastIndex = o.index + o[0].length;
    let end = md.length;
    for (let m = ANY.exec(md); m; m = ANY.exec(md)) {
      depth += m[1] ? -1 : 1;
      if (depth === 0) {
        end = m.index + m[0].length;
        break;
      }
    }
    at = end;
  }
  out += md.slice(at);
  // A stray closing mark with no opening one: drop the mark, keep the text (nothing was hidden).
  out = out.replace(/<\/redact\b[^>]*>/gi, "");
  out = out.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  out = out.replace(/%%[\s\S]*?%%/g, "");
  return out;
}

type ExportDoor = { exportReadyText: (markdown: string, inlinePhotos?: boolean) => Promise<string> };
// #473's door, when this build has it (the share link's seam, src/share/shareReady.ts).
const doors = import.meta.glob<ExportDoor>("../storage/exportReady*.ts");

/** The text a public record is built from: #473's export door when present, then `privateRemoved` either way. */
export async function publishReadyText(markdown: string): Promise<string> {
  const load = doors["../storage/exportReady.ts"];
  const text = load ? await (await load()).exportReadyText(markdown, false) : markdown;
  return privateRemoved(text);
}

/** Readable text: Markdown syntax off, for search and previews. */
export function plainTextOf(md: string): string {
  return privateRemoved(md)
    .replace(FRONTMATTER, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a: string, b?: string) => b ?? a)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`>~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A summary: frontmatter `description`, else the first ~300 characters, cut at a word. */
export function summaryOf(raw: string): string {
  const md = privateRemoved(raw);
  const fm = FRONTMATTER.exec(md)?.[1] ?? "";
  const d = /^description:\s*["']?(.+?)["']?\s*$/m.exec(fm)?.[1];
  if (d) return d.trim();
  const body = plainTextOf(md.replace(/^#\s+.*$/m, ""));
  if (body.length <= 300) return body;
  const cut = body.slice(0, 300);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 200)) + "…";
}

export function tagsOf(md: string): string[] {
  const fm = FRONTMATTER.exec(md)?.[1] ?? "";
  const inline = /^tags:\s*\[(.*)\]\s*$/m.exec(fm)?.[1];
  const tags = inline ? inline.split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")) : [...fm.matchAll(/^\s*-\s+(.+)$/gm)].map((m) => m[1].trim());
  return [...new Set(tags.filter(Boolean))].slice(0, 20);
}

export function documentRecord(opts: { site: string; path: string; markdown: string; publishedAt: Date; updatedAt?: Date }): StandardDocument {
  // Never trust the caller: whatever it passed, the record is built from the redacted text.
  const md = privateRemoved(opts.markdown);
  const tags = tagsOf(md);
  return {
    $type: DOCUMENT_NSID,
    site: opts.site,
    title: noteTitle(md, opts.path),
    publishedAt: opts.publishedAt.toISOString(),
    path: "/" + opts.path.replace(/\.md$/i, "").split("/").map(encodeURIComponent).join("/"),
    description: summaryOf(md),
    textContent: plainTextOf(md),
    content: { $type: MARKDOWN_TYPE, text: md },
    ...(tags.length ? { tags } : {}),
    ...(opts.updatedAt ? { updatedAt: opts.updatedAt.toISOString() } : {}),
  };
}

/**
 * A stable record key for a note: the same note always updates the same
 * record. 13 characters of base32-sortable from an FNV-1a hash of the path;
 * a valid AT record key ([a-z2-7], not "." or "..").
 */
export function rkeyFor(path: string): string {
  const alphabet = "234567abcdefghijklmnopqrstuvwxyz";
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < path.length; i++) {
    h1 = Math.imul(h1 ^ path.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ path.charCodeAt(i), 0x5bd1e995) >>> 0;
  }
  let n = (BigInt(h1) << 32n) | BigInt(h2);
  let out = "";
  for (let i = 0; i < 13; i++) {
    out = alphabet[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

export const atUri = (did: string, collection: string, rkey: string) => `at://${did}/${collection}/${rkey}`;

// ------------------------------------------------------------ site verification

/** The file `/.well-known/site.standard.publication` serves: the publication's at:// URI, text/plain. */
export function wellKnownFile(publicationUri: string): { path: string; data: string; contentType: string } {
  if (!/^at:\/\/did:[a-z]+:[^/]+\/site\.standard\.publication\/[A-Za-z0-9._:~-]+$/.test(publicationUri)) throw new Error(`not a publication at:// URI: ${publicationUri}`);
  return { path: WELL_KNOWN_PATH, data: publicationUri, contentType: "text/plain" };
}

/** `<link>` tags that tie a page to its records. */
export function linkTags(publicationUri: string, documentUri?: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `\n<link rel="site.standard.publication" href="${esc(publicationUri)}" />${documentUri ? `\n<link rel="site.standard.document" href="${esc(documentUri)}" />` : ""}`;
}

// ------------------------------------------------------------ the PDS client

export interface AtSession {
  did: string;
  handle: string;
  accessJwt: string;
  /** Kept in the secret store so the next Publish needs no password. */
  refreshJwt?: string;
  /** The user's PDS (from the DID document), where records are written. */
  pds: string;
}

export class AtprotoError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "AtprotoError";
  }
}

async function xrpc<T>(f: typeof fetch, base: string, nsid: string, init: { method?: "GET" | "POST"; body?: unknown; jwt?: string; query?: Record<string, string> } = {}): Promise<T> {
  const url = new URL(`/xrpc/${nsid}`, base);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.jwt) headers.Authorization = `Bearer ${init.jwt}`;
  // privacy-ledger: the caller passes atprotoFetch(), which records every request to the user's PDS.
  const res = await f(url.href, { method: init.method ?? (init.body !== undefined ? "POST" : "GET"), headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) throw new AtprotoError(`${nsid}: ${String(json.message ?? res.status)}`, res.status, String(json.error ?? "Error"));
  return json as T;
}

/** The PDS endpoint in a DID document (`#atproto_pds`). */
export function pdsOf(didDoc: { service?: Array<{ id: string; type: string; serviceEndpoint: string }> }): string | null {
  const s = didDoc.service?.find((x) => x.id.endsWith("#atproto_pds") || x.type === "AtprotoPersonalDataServer");
  if (!s) return null;
  // Review 20 (RR20-587-2): the access token goes there, so only https.
  try {
    return new URL(s.serviceEndpoint).protocol === "https:" ? s.serviceEndpoint.replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

/**
 * Log in with an App Password: createSession on the entryway (bsky.social for
 * Bluesky-hosted accounts, or the user's own PDS), then the DID document
 * (plc.directory for did:plc) for the PDS records go to.
 */
type SessionReply = { did: string; handle: string; accessJwt: string; refreshJwt?: string; didDoc?: { service?: Array<{ id: string; type: string; serviceEndpoint: string }> } };

export async function login(f: typeof fetch, opts: { identifier: string; appPassword: string; service?: string; plc?: string }): Promise<AtSession> {
  const service = opts.service ?? "https://bsky.social";
  const s = await xrpc<SessionReply>(f, service, "com.atproto.server.createSession", { body: { identifier: opts.identifier, password: opts.appPassword } });
  return sessionFrom(f, s, service, opts.plc);
}

/** A new session from the stored refresh token (no password): com.atproto.server.refreshSession. */
export async function resume(f: typeof fetch, opts: { refreshJwt: string; service?: string; plc?: string }): Promise<AtSession> {
  const service = opts.service ?? "https://bsky.social";
  const s = await xrpc<SessionReply>(f, service, "com.atproto.server.refreshSession", { method: "POST", jwt: opts.refreshJwt });
  return sessionFrom(f, s, service, opts.plc);
}

async function sessionFrom(f: typeof fetch, s: SessionReply, service: string, plc?: string): Promise<AtSession> {
  let pds = s.didDoc ? pdsOf(s.didDoc) : null;
  if (!pds && s.did.startsWith("did:plc:")) {
    // privacy-ledger: the caller passes atprotoFetch(); plc.directory resolves the user's DID.
    const res = await f(`${plc ?? "https://plc.directory"}/${s.did}`);
    if (res.ok) pds = pdsOf((await res.json()) as Parameters<typeof pdsOf>[0]);
  }
  return { did: s.did, handle: s.handle, accessJwt: s.accessJwt, ...(s.refreshJwt ? { refreshJwt: s.refreshJwt } : {}), pds: pds ?? service };
}

export async function putRecord(f: typeof fetch, s: AtSession, collection: string, rkey: string, record: object): Promise<{ uri: string; cid: string }> {
  return xrpc(f, s.pds, "com.atproto.repo.putRecord", { jwt: s.accessJwt, body: { repo: s.did, collection, rkey, record } });
}

export async function deleteRecord(f: typeof fetch, s: AtSession, collection: string, rkey: string): Promise<void> {
  await xrpc(f, s.pds, "com.atproto.repo.deleteRecord", { jwt: s.accessJwt, body: { repo: s.did, collection, rkey } });
}

export interface PublishResult {
  publication: string;
  document: string;
  /** The note's address on the static site, which Bluesky previews. */
  url: string;
}

/** Publish (or update: the same note keeps its record) one note. The note is redacted here, whatever the caller passes. */
export async function publishNote(f: typeof fetch, s: AtSession, opts: { site: { url: string; name: string; description?: string }; path: string; markdown: string; now: Date; publishedAt?: Date }): Promise<PublishResult> {
  const pub = publicationRecord(opts.site);
  const pubRkey = rkeyFor(pub.url);
  const publication = (await putRecord(f, s, PUBLICATION_NSID, pubRkey, pub)).uri;
  const doc = documentRecord({ site: publication, path: opts.path, markdown: await publishReadyText(opts.markdown), publishedAt: opts.publishedAt ?? opts.now, ...(opts.publishedAt ? { updatedAt: opts.now } : {}) });
  const document = (await putRecord(f, s, DOCUMENT_NSID, rkeyFor(opts.path), doc)).uri;
  return { publication, document, url: `${pub.url}${doc.path}.html` };
}

export const unpublishNote = (f: typeof fetch, s: AtSession, path: string): Promise<void> => deleteRecord(f, s, DOCUMENT_NSID, rkeyFor(path));

export class DeclinedError extends Error {
  constructor() {
    super("The user did not confirm publishing");
    this.name = "DeclinedError";
  }
}

export const ATPROTO_REASON = "Publish to the AT Protocol (Standard.site), your PDS";

/**
 * The app's fetch for this: nothing is sent before the user confirms (asked
 * once per action), then every request is recorded in the privacy ledger.
 */
export async function atprotoFetch(confirm: () => Promise<boolean>): Promise<typeof fetch> {
  const { ledgerFetch } = await import("../ai/privacyLedger");
  const send = ledgerFetch({ force: { category: "third-party", reason: ATPROTO_REASON }, consent: true });
  let asked: Promise<boolean> | null = null;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked ??= confirm();
    if (!(await asked)) throw new DeclinedError();
    return send(input, init);
  }) as typeof fetch;
}
