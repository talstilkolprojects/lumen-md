/**
 * W6.47 — highlights made in Lumen's PDF reader go back to Zotero, as
 * Zotero annotation items on the PDF's attachment, through the Zotero Web
 * API (W5.23, ./zoteroWeb.ts). The first and only write Lumen makes to
 * zotero.org, so it is guarded:
 *
 *   • Explicit consent, every time: the user presses "Send to Zotero" and
 *     confirms a dialog that says how many highlights go to which item and
 *     that zotero.org will store them (the reader asks; this module refuses
 *     to send without `consent: true`).
 *   • The same API key as the read sync, from the secret store; the key must
 *     have write access (GET /keys/current → access.user.write), else nothing
 *     is sent and the user is told how to allow it.
 *   • The route is the privacy ledger's api.zotero.org rule (category
 *     "research"): every request is recorded, and a local-only policy blocks
 *     it like the read sync.
 *   • Idempotent: one Zotero-Write-Token per batch (a retried request is not
 *     applied twice), and what was sent is remembered per highlight in
 *     `.lumen/zotero-annotations.json` — a highlight already in Zotero is not
 *     sent again.
 *
 * The item (Zotero's annotation schema, as Zotero 7 writes it):
 *   itemType "annotation", parentItem = the PDF attachment's key,
 *   annotationType "highlight", annotationText = the quote,
 *   annotationComment = the highlight's note, annotationColor "#ffd400",
 *   annotationPageLabel = the page number, annotationSortIndex
 *   "PPPPP|OOOOOO|YYYYY" (page index | character offset | y from the top, in
 *   points), annotationPosition = JSON {pageIndex, rects: [[x1,y1,x2,y2]]} in
 *   PDF points with the origin at the bottom-left (Lumen keeps top-left).
 * Source: zotero.org/support/dev/web_api/v3/write_requests (batches of ≤ 50,
 * write token, successful / unchanged / failed) and Zotero's annotation
 * fields; the fixtures follow those documents (api.zotero.org can't be
 * reached from where this was built).
 */
import { describeAnnotation, shortId, type PdfAnnotation } from "../pdf/annotations";
import { ZOTERO_API, type ZoteroWebState, type FetchLike } from "./zoteroWeb";

export const SENT_FILE = ".lumen/zotero-annotations.json";
// design-allow: the annotation colour Zotero stores with each highlight (data sent to its API, not an interface colour)
export const HIGHLIGHT_COLOR = "#ffd400";
const MAX_BATCH = 50;

export class ZoteroWriteError extends Error {
  readonly reason: "no-consent" | "no-key" | "no-write-access" | "forbidden" | "no-attachment" | "rate-limited" | "error";
  constructor(reason: ZoteroWriteError["reason"], message: string) {
    super(message);
    this.name = "ZoteroWriteError";
    this.reason = reason;
  }
}

/** The annotation item Zotero stores for one highlight. */
export interface ZoteroAnnotationItem {
  itemType: "annotation";
  parentItem: string;
  annotationType: "highlight";
  annotationText: string;
  annotationComment: string;
  annotationColor: string;
  annotationPageLabel: string;
  annotationSortIndex: string;
  annotationPosition: string;
  tags: { tag: string }[];
}

const pad = (n: number, w: number) => String(Math.max(0, Math.min(10 ** w - 1, Math.round(n)))).padStart(w, "0");

/**
 * The Zotero item for highlight `a` on attachment `parentItem`. `pageHeight`
 * (PDF points) turns Lumen's top-left rectangle into Zotero's bottom-left
 * one. Null for a highlight with no quote.
 */
export function toZoteroAnnotation(a: PdfAnnotation, parentItem: string, pageHeight: number | undefined): ZoteroAnnotationItem | null {
  const d = describeAnnotation(a);
  const text = d.quote?.exact?.trim();
  if (!text) return null;
  const pageIndex = d.page - 1;
  const rects: number[][] = [];
  if (d.rect && pageHeight) {
    const r = d.rect;
    const round = (x: number) => Math.round(x * 1000) / 1000;
    rects.push([round(r.left), round(pageHeight - (r.top + r.height)), round(r.left + r.width), round(pageHeight - r.top)]);
  }
  const tags = (a.body ?? []).filter((b) => b.purpose === "tagging").map((b) => ({ tag: b.value }));
  return {
    itemType: "annotation",
    parentItem,
    annotationType: "highlight",
    annotationText: text,
    annotationComment: d.note,
    annotationColor: HIGHLIGHT_COLOR,
    annotationPageLabel: String(d.page),
    annotationSortIndex: `${pad(pageIndex, 5)}|${pad(d.position?.start ?? 0, 6)}|${pad(d.rect?.top ?? 0, 5)}`,
    annotationPosition: JSON.stringify({ pageIndex, rects }),
    tags,
  };
}

/**
 * The PDF attachment in the synced Zotero library (W5.23's state) that a
 * vault PDF is: the key the companion note names (`zotero-attachment:`),
 * else the one PDF attachment with the same file name. Null when there is
 * none or more than one.
 */
export function findAttachmentKey(state: Pick<ZoteroWebState, "items">, pdfPath: string, named?: string | null): string | null {
  if (named && /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/.test(named) && state.items[named]?.attachment) return named;
  const file = (pdfPath.split("/").pop() ?? pdfPath).normalize("NFC").toLowerCase();
  const hits = Object.entries(state.items).filter(
    ([, it]) => it.attachment && /pdf/i.test(it.attachment.contentType) && (it.attachment.filename ?? "").normalize("NFC").toLowerCase() === file,
  );
  return hits.length === 1 ? hits[0][0] : null;
}

/** `zotero-attachment: KEY` in a note's front matter. */
export function namedAttachment(note: string | null): string | null {
  const fm = note && /^---\r?\n([\s\S]*?)\r?\n---/.exec(note);
  const m = fm && /^zotero-attachment:\s*["']?([A-Z0-9]{8})["']?\s*$/m.exec(fm[1]);
  return m ? m[1] : null;
}

/** What was sent: our highlight id → the Zotero item key. */
export interface SentFile {
  v: 1;
  sent: Record<string, { key: string; parent: string; at: number }>;
}

export function parseSent(text: string | null): SentFile {
  try {
    const o = text ? (JSON.parse(text) as Partial<SentFile>) : null;
    if (o?.v === 1 && o.sent && typeof o.sent === "object") return { v: 1, sent: o.sent };
  } catch {
    /* why: unreadable — start again; Zotero-side duplicates are what the token prevents within one send */
  }
  return { v: 1, sent: {} };
}

/** A random Zotero-Write-Token: 32 hex characters. */
export function writeToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface WriteResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: string;
}

/** One request against the API, GET or POST, with the key and version headers. */
export type ZoteroCall = (method: "GET" | "POST", path: string, body?: unknown, headers?: Record<string, string>) => Promise<WriteResponse>;

/** The real API through `fetch` (the window's, which the privacy ledger wraps). Retries 429 / 503 like the read sync. */
export function zoteroCall(key: string, doFetch: FetchLike, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): ZoteroCall {
  return async (method, path, body, headers = {}) => {
    for (let attempt = 0; ; attempt++) {
      // privacy-ledger: research — api.zotero.org (privacyLedger RULES), the user's own key; POST only after the user confirmed
      const res = await doFetch(`${ZOTERO_API}${path}`, {
        method,
        headers: { "Zotero-API-Key": key, "Zotero-API-Version": "3", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if ((res.status === 429 || res.status === 503) && attempt < 4) {
        const after = Number(res.headers.get("Retry-After"));
        await sleep((after > 0 ? after : 2 ** attempt) * 1000);
        continue;
      }
      return { status: res.status, headers: res.headers, body: await res.text() };
    }
  };
}

export interface SendReport {
  sent: number;
  skipped: number;
  failed: Array<{ id: string; message: string }>;
  requests: number;
  sentFile: SentFile;
}

/**
 * Send the highlights not sent before to attachment `parentItem`. Refuses
 * without `consent`; checks the key can write before anything is posted.
 * `pageHeights[i]` is page i+1's height in points.
 */
export async function sendAnnotations(opts: {
  call: ZoteroCall;
  userID: number;
  parentItem: string;
  annotations: readonly PdfAnnotation[];
  pageHeights: readonly number[];
  sentFile: SentFile;
  consent: boolean;
  now?: number;
}): Promise<SendReport> {
  if (!opts.consent) throw new ZoteroWriteError("no-consent", "Nothing is sent to Zotero without the user's confirmation");
  let requests = 0;
  const keyRes = await opts.call("GET", "/keys/current");
  requests++;
  if (keyRes.status === 403) throw new ZoteroWriteError("forbidden", "Zotero refused the key");
  if (keyRes.status !== 200) throw new ZoteroWriteError("error", `Zotero answered ${keyRes.status} (/keys/current)`);
  const k = JSON.parse(keyRes.body) as { userID?: number; access?: { user?: { library?: boolean; write?: boolean } } };
  if (k.userID !== opts.userID) throw new ZoteroWriteError("forbidden", "The key belongs to another Zotero user than the synced library");
  if (!k.access?.user?.write) throw new ZoteroWriteError("no-write-access", "The key can't write to your library");

  const sentFile: SentFile = { v: 1, sent: { ...opts.sentFile.sent } };
  const todo: Array<{ id: string; item: ZoteroAnnotationItem }> = [];
  let skipped = 0;
  for (const a of opts.annotations) {
    const id = shortId(a.id);
    if (sentFile.sent[id]) {
      skipped++;
      continue;
    }
    const item = toZoteroAnnotation(a, opts.parentItem, opts.pageHeights[describeAnnotation(a).page - 1]);
    if (item) todo.push({ id, item });
    else skipped++;
  }
  const failed: SendReport["failed"] = [];
  let sent = 0;
  for (let i = 0; i < todo.length; i += MAX_BATCH) {
    const batch = todo.slice(i, i + MAX_BATCH);
    const res = await opts.call(
      "POST",
      `/users/${opts.userID}/items`,
      batch.map((b) => b.item),
      { "Zotero-Write-Token": writeToken() },
    );
    requests++;
    if (res.status === 403) throw new ZoteroWriteError("no-write-access", "Zotero refused the write");
    if (res.status === 429) throw new ZoteroWriteError("rate-limited", "Zotero asked to slow down");
    if (res.status !== 200) throw new ZoteroWriteError("error", `Zotero answered ${res.status}: ${res.body.slice(0, 200)}`);
    const out = JSON.parse(res.body) as {
      successful?: Record<string, { key: string }>;
      success?: Record<string, string>;
      unchanged?: Record<string, string>;
      failed?: Record<string, { key?: string; code?: number; message?: string }>;
    };
    batch.forEach((b, j) => {
      const key = out.successful?.[j]?.key ?? out.success?.[j] ?? out.unchanged?.[j];
      if (key) {
        sentFile.sent[b.id] = { key, parent: opts.parentItem, at: opts.now ?? Date.now() };
        sent++;
      } else failed.push({ id: b.id, message: out.failed?.[j]?.message ?? "not saved" });
    });
  }
  return { sent, skipped, failed, requests, sentFile };
}
