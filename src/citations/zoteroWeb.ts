/**
 * Zotero sync through the Zotero Web API, without Zotero Desktop (plan
 * W5.23) — read-only, so the phone and the web app get the library too.
 *
 *   GET /keys/current                         who the key belongs to, and that it can read the library
 *   GET /users/<id>/items?since=V&format=versions   (If-Modified-Since-Version: V → 304 when nothing changed)
 *   GET /users/<id>/items?itemKey=a,b,…&include=data,csljson   ≤ 50 keys a request
 *   GET /users/<id>/collections?since=V&format=versions, then by collectionKey
 *   GET /users/<id>/deleted?since=V           what was removed since V
 *
 * The library version (Last-Modified-Version) is kept in
 * `.lumen/zotero-web.json` with every item's version, so the next sync asks
 * only for what changed. Top-level items become the CSL-JSON copy the cite
 * dialog already reads (`.lumen/zotero-library.csl.json`); child notes and
 * PDF attachments become one note per item under `Zotero/`, headed with its
 * `[@key]`. `Backoff` and `429 Retry-After` are honoured.
 *
 * The key is the user's own (zotero.org → Settings → Security → Applications,
 * read-only), kept in the secret store, sent only as the Zotero-API-Key
 * header to api.zotero.org — a cloud route in the privacy ledger.
 */
import type { CslItem } from "./csl";

export const ZOTERO_API = "https://api.zotero.org";
export const ZOTERO_KEY_SECRET = "lumen.zotero.apiKey";
export const WEB_STATE_FILE = ".lumen/zotero-web.json";

export interface WebResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: string;
}

/** One GET against the API: `path` starts with "/", headers are added to the auth ones. */
export type WebGet = (path: string, headers?: Record<string, string>) => Promise<WebResponse>;

export interface StoredItem {
  version: number;
  type: string;
  parent?: string;
  collections: string[];
  title?: string;
  csl?: CslItem;
  /** A child note's HTML. */
  note?: string;
  /** An attachment: how it is stored and what it is. */
  attachment?: { mode: string; contentType: string; filename?: string; url?: string };
}

export interface ZoteroWebState {
  v: 1;
  userID: number | null;
  username: string;
  /** The library version the state is at (Last-Modified-Version). */
  version: number;
  items: Record<string, StoredItem>;
  collections: Record<string, { name: string; parent: string | null; version: number }>;
}

export const emptyState = (): ZoteroWebState => ({ v: 1, userID: null, username: "", version: 0, items: {}, collections: {} });

export class ZoteroWebError extends Error {
  readonly reason: "no-key" | "forbidden" | "no-library-access" | "rate-limited" | "error";
  constructor(reason: ZoteroWebError["reason"], message: string) {
    super(message);
    this.name = "ZoteroWebError";
    this.reason = reason;
  }
}

export interface FetchLike {
  (url: string, init: RequestInit): Promise<Response>;
}

/**
 * The real API, through `fetch` (the window's, which the privacy ledger
 * wraps). Retries a 429 / 503 after Retry-After (or 1, 2, 4… s, at most 4
 * times) and waits out a Backoff header before the next request.
 */
export function zoteroWebGet(key: string, doFetch: FetchLike, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): WebGet {
  let backoffUntil = 0;
  return async (path, headers = {}) => {
    for (let attempt = 0; ; attempt++) {
      const wait = backoffUntil - Date.now();
      if (wait > 0) await sleep(wait);
      // privacy-ledger: research — api.zotero.org (privacyLedger RULES), the user's own key, read-only
      const res = await doFetch(`${ZOTERO_API}${path}`, { headers: { "Zotero-API-Key": key, "Zotero-API-Version": "3", ...headers } });
      const backoff = Number(res.headers.get("Backoff"));
      if (backoff > 0) backoffUntil = Date.now() + backoff * 1000;
      if ((res.status === 429 || res.status === 503) && attempt < 4) {
        const after = Number(res.headers.get("Retry-After"));
        await sleep((after > 0 ? after : 2 ** attempt) * 1000);
        continue;
      }
      return { status: res.status, headers: res.headers, body: res.status === 304 ? "" : await res.text() };
    }
  };
}

function check(r: WebResponse, what: string): void {
  if (r.status === 200 || r.status === 304) return;
  if (r.status === 403) throw new ZoteroWebError("forbidden", `Zotero refused the key (${what})`);
  if (r.status === 429) throw new ZoteroWebError("rate-limited", "Zotero asked to slow down; try again in a few minutes");
  throw new ZoteroWebError("error", `Zotero answered ${r.status} (${what}): ${r.body.slice(0, 200)}`);
}

const versionOf = (r: WebResponse) => Number(r.headers.get("Last-Modified-Version")) || 0;
const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

interface ApiItem {
  key: string;
  version: number;
  data: {
    itemType: string;
    parentItem?: string;
    collections?: string[];
    title?: string;
    note?: string;
    linkMode?: string;
    contentType?: string;
    filename?: string;
    url?: string;
  };
  csljson?: CslItem;
}

export interface SyncReport {
  state: ZoteroWebState;
  notModified: boolean;
  changed: number;
  deleted: number;
  requests: number;
}

/**
 * Bring `state` up to the library's current version. A first sync (version
 * 0) reads everything; later ones only what changed since, and nothing at
 * all (one request, 304) when the library did not change.
 */
export async function syncZoteroWeb(prev: ZoteroWebState, get: WebGet): Promise<SyncReport> {
  const state: ZoteroWebState = { ...prev, items: { ...prev.items }, collections: { ...prev.collections } };
  let requests = 0;
  const call = async (path: string, headers?: Record<string, string>) => {
    requests++;
    const r = await get(path, headers);
    check(r, path.split("?")[0]);
    return r;
  };
  if (!state.userID) {
    const r = await call("/keys/current");
    const k = JSON.parse(r.body) as { userID?: number; username?: string; access?: { user?: { library?: boolean } } };
    if (!k.userID) throw new ZoteroWebError("forbidden", "The key has no user");
    if (!k.access?.user?.library) throw new ZoteroWebError("no-library-access", "The key can't read your library: give it “Allow library access”");
    state.userID = k.userID;
    state.username = k.username ?? "";
  }
  const lib = `/users/${state.userID}`;
  const since = state.version;
  const versions = await call(`${lib}/items?since=${since}&format=versions`, since ? { "If-Modified-Since-Version": String(since) } : {});
  if (versions.status === 304) return { state, notModified: true, changed: 0, deleted: 0, requests };
  const target = versionOf(versions);
  const changedKeys = Object.entries(JSON.parse(versions.body) as Record<string, number>)
    .filter(([k, v]) => state.items[k]?.version !== v)
    .map(([k]) => k);

  // Collections: their names, for the notes' frontmatter.
  const colVersions = JSON.parse((await call(`${lib}/collections?since=${since}&format=versions`)).body) as Record<string, number>;
  for (const batch of chunks(Object.keys(colVersions), 50)) {
    const r = await call(`${lib}/collections?collectionKey=${batch.join(",")}&limit=50`);
    for (const c of JSON.parse(r.body) as Array<{ key: string; version: number; data: { name: string; parentCollection?: string | false } }>) {
      state.collections[c.key] = { name: c.data.name, parent: c.data.parentCollection || null, version: c.version };
    }
  }

  for (const batch of chunks(changedKeys, 50)) {
    const r = await call(`${lib}/items?itemKey=${batch.join(",")}&include=data,csljson&limit=50`);
    for (const it of JSON.parse(r.body) as ApiItem[]) {
      const d = it.data;
      state.items[it.key] = {
        version: it.version,
        type: d.itemType,
        ...(d.parentItem ? { parent: d.parentItem } : {}),
        collections: d.collections ?? [],
        ...(d.title ? { title: d.title } : {}),
        ...(d.itemType !== "note" && d.itemType !== "attachment" && it.csljson ? { csl: it.csljson } : {}),
        ...(d.itemType === "note" && d.note ? { note: d.note } : {}),
        ...(d.itemType === "attachment" ? { attachment: { mode: d.linkMode ?? "", contentType: d.contentType ?? "", ...(d.filename ? { filename: d.filename } : {}), ...(d.url ? { url: d.url } : {}) } } : {}),
      };
    }
  }

  let deleted = 0;
  if (since) {
    const del = JSON.parse((await call(`${lib}/deleted?since=${since}`)).body) as { items?: string[]; collections?: string[] };
    for (const k of del.items ?? []) if (state.items[k]) {
      delete state.items[k];
      deleted++;
    }
    for (const k of del.collections ?? []) delete state.collections[k];
  }
  state.version = target || state.version;
  return { state, notModified: false, changed: changedKeys.length, deleted, requests };
}

/** The top-level items as CSL-JSON, in a stable order (the cite dialog's Zotero copy). */
export function stateCsl(state: ZoteroWebState): CslItem[] {
  return Object.entries(state.items)
    .filter(([, it]) => !it.parent && it.csl)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, it]) => ({ ...(it.csl as CslItem), id: (it.csl as CslItem).id ?? key }));
}

export interface ItemNote {
  path: string;
  content: string;
}

/**
 * One vault note per item that has child notes or PDFs: its `[@key]`, its
 * collections, the notes as Markdown and the PDFs as links that open them
 * in Zotero (desktop) or on zotero.org.
 */
export function itemNotes(state: ZoteroWebState, citeKeyOf: (itemKey: string) => string | null, htmlToMarkdown: (html: string) => string): ItemNote[] {
  const children = new Map<string, Array<[string, StoredItem]>>();
  for (const [k, it] of Object.entries(state.items)) if (it.parent) children.set(it.parent, [...(children.get(it.parent) ?? []), [k, it]]);
  const out: ItemNote[] = [];
  for (const [parentKey, kids] of [...children].sort(([a], [b]) => a.localeCompare(b))) {
    const parent = state.items[parentKey];
    const cite = citeKeyOf(parentKey);
    if (!parent || !cite) continue;
    const notes = kids.filter(([, k]) => k.note).sort(([a], [b]) => a.localeCompare(b));
    const pdfs = kids.filter(([, k]) => k.attachment && /pdf/i.test(k.attachment.contentType)).sort(([a], [b]) => a.localeCompare(b));
    if (!notes.length && !pdfs.length) continue;
    const cols = parent.collections.map((c) => state.collections[c]?.name).filter((x): x is string => !!x);
    const title = (parent.csl?.title ?? parent.title ?? cite).replace(/\n/g, " ");
    const fm = [`source: "zotero"`, `zotero: ${JSON.stringify(parentKey)}`, `citekey: ${JSON.stringify(cite)}`, ...(cols.length ? [`collections: [${cols.map((c) => JSON.stringify(c)).join(", ")}]`] : [])].join("\n");
    const body: string[] = [`# ${title} [@${cite}]`];
    if (notes.length) body.push("## Notes", ...notes.map(([, n]) => htmlToMarkdown(n.note as string).trim()));
    if (pdfs.length) {
      body.push(
        "## PDF",
        pdfs
          .map(([k, a]) => {
            const name = (a.attachment?.filename ?? a.title ?? "PDF").replace(/[[\]]/g, "");
            const web = state.username ? ` · [zotero.org](https://www.zotero.org/${encodeURIComponent(state.username)}/items/${k})` : "";
            return a.attachment?.mode === "linked_url" && a.attachment.url ? `- [${name}](${a.attachment.url})` : `- [${name}](zotero://open-pdf/library/items/${k})${web}`;
          })
          .join("\n"),
      );
    }
    out.push({ path: `Zotero/${cite.replace(/[\\/:*?"<>|#^[\]]/g, "_")}.md`, content: `---\n${fm}\n---\n\n${body.join("\n\n")}\n` });
  }
  return out;
}
