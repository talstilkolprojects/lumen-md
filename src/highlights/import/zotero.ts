/**
 * Zotero (plan W2.15) through its local API (Zotero 7+, Settings →
 * Advanced → "Allow other applications on this computer to communicate
 * with Zotero"): http://127.0.0.1:23119/api/users/0/… — the user's own
 * library, read on this computer, no cloud. Zotero refuses requests from
 * browsers, so the desktop app asks it natively (src-tauri:
 * zotero_local_get); the web app explains that.
 *
 * Every highlight and underline annotation becomes a highlight of the item
 * its PDF / EPUB is attached to, with a link that opens it in Zotero
 * (zotero://open-pdf/…?annotation=…), and the item links back too
 * (zotero://select/…). Note annotations keep their comment; image and ink
 * annotations have no text and are skipped.
 */

import { bump, groupBooks, highlightId, type ImportReport, type ImportedHighlight } from "./model";

export interface LocalResponse {
  status: number;
  /** The Total-Results header, when sent. */
  total: number | null;
  body: string;
}
export type LocalGet = (path: string) => Promise<LocalResponse>;

export class ZoteroUnavailable extends Error {
  readonly reason: "not-running" | "disabled" | "browser" | "error";
  constructor(reason: "not-running" | "disabled" | "browser" | "error", message: string) {
    super(message);
    this.name = "ZoteroUnavailable";
    this.reason = reason;
  }
}

interface ZItem {
  key: string;
  data: {
    key: string;
    itemType: string;
    parentItem?: string;
    title?: string;
    creators?: Array<{ firstName?: string; lastName?: string; name?: string; creatorType?: string }>;
    date?: string;
    annotationType?: string;
    annotationText?: string;
    annotationComment?: string;
    annotationColor?: string;
    annotationPageLabel?: string;
    annotationSortIndex?: string;
    tags?: Array<{ tag: string }>;
    dateAdded?: string;
  };
}

const PAGE = 100;

async function getJson(get: LocalGet, path: string): Promise<{ items: ZItem[]; total: number | null }> {
  const r = await get(path);
  if (r.status === 403) throw new ZoteroUnavailable("disabled", r.body || "Local API is not enabled");
  if (r.status !== 200) throw new ZoteroUnavailable("error", `Zotero answered ${r.status}: ${r.body.slice(0, 200)}`);
  const v = JSON.parse(r.body) as ZItem[] | ZItem;
  return { items: Array.isArray(v) ? v : [v], total: r.total };
}

/** Every item of a query, page by page (the local API gives at most 100 per request). */
async function all(get: LocalGet, path: string): Promise<ZItem[]> {
  const out: ZItem[] = [];
  for (let start = 0; ; start += PAGE) {
    const { items, total } = await getJson(get, `${path}${path.includes("?") ? "&" : "?"}limit=${PAGE}&start=${start}`);
    out.push(...items);
    if (items.length < PAGE || (total !== null && out.length >= total)) return out;
  }
}

async function byKeys(get: LocalGet, keys: readonly string[]): Promise<Map<string, ZItem>> {
  const out = new Map<string, ZItem>();
  const uniq = [...new Set(keys)];
  for (let i = 0; i < uniq.length; i += 50) for (const it of await all(get, `/api/users/0/items?itemKey=${uniq.slice(i, i + 50).join(",")}`)) out.set(it.key, it);
  return out;
}

export function creatorsLine(creators: ZItem["data"]["creators"] = []): string {
  const authors = creators.filter((c) => !c.creatorType || c.creatorType === "author");
  return (authors.length ? authors : creators).map((c) => c.name ?? [c.firstName, c.lastName].filter(Boolean).join(" ")).filter(Boolean).join(", ");
}

/** The page index from Zotero's sort index ("00012|003456|00789"), for the order. */
const sortOf = (idx?: string) => {
  const parts = (idx ?? "").split("|").map(Number);
  return (parts[0] || 0) * 1e6 + (parts[1] || 0);
};

export async function importZotero(get: LocalGet): Promise<ImportReport> {
  const skipped: Record<string, number> = {};
  const annotations = await all(get, "/api/users/0/items?itemType=annotation");
  const attachments = await byKeys(get, annotations.map((a) => a.data.parentItem ?? "").filter(Boolean));
  const parents = await byKeys(get, [...attachments.values()].map((a) => a.data.parentItem ?? "").filter(Boolean));
  const rows: Parameters<typeof groupBooks>[1] = [];
  for (const a of annotations) {
    const d = a.data;
    const kind = d.annotationType ?? "";
    if (kind === "image" || kind === "ink") {
      bump(skipped, `${kind}-annotation`);
      continue;
    }
    const text = (d.annotationText ?? "").trim();
    const note = (d.annotationComment ?? "").trim();
    if (!text && !note) {
      bump(skipped, "empty");
      continue;
    }
    const att = attachments.get(d.parentItem ?? "");
    const parent = att?.data.parentItem ? parents.get(att.data.parentItem) : undefined;
    const item = parent ?? att;
    if (!item) {
      bump(skipped, "no-item");
      continue;
    }
    const title = (item.data.title ?? "").trim() || item.key;
    const author = parent ? creatorsLine(parent.data.creators) : "";
    const page = d.annotationPageLabel?.trim();
    const h: ImportedHighlight = {
      id: highlightId(title, author, text, note),
      text,
      note,
      location: page ? `p. ${page}` : null,
      sort: sortOf(d.annotationSortIndex),
      created: d.dateAdded ?? null,
      color: d.annotationColor ?? null,
      tags: (d.tags ?? []).map((t) => t.tag.trim().replace(/\s+/g, "-")).filter(Boolean),
      link: att ? `zotero://open-pdf/library/items/${att.key}${page ? `?page=${encodeURIComponent(page)}&` : "?"}annotation=${a.key}` : null,
    };
    rows.push({ title, author, link: `zotero://select/library/items/${item.key}`, h });
  }
  return { books: groupBooks("zotero", rows), skipped };
}

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** The desktop app's native request to Zotero on this computer. */
export async function desktopZoteroGet(): Promise<LocalGet> {
  if (!isTauri()) throw new ZoteroUnavailable("browser", "Zotero only answers apps on this computer: use the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  return async (path) => {
    try {
      return await invoke<LocalResponse>("zotero_local_get", { path });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      throw new ZoteroUnavailable(/refused|connect/i.test(msg) ? "not-running" : "error", msg);
    }
  };
}
