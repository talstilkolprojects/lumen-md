/**
 * Apple iWork (.pages / .numbers / .key) → Markdown — zero dependencies.
 *
 * Every iWork document is a ZIP. Two generations exist:
 *
 *  1. iWork '05–'09 ("XML iWork"): the archive holds `index.xml` (Pages,
 *     Numbers) or `index.apxl` (Keynote), sometimes gzipped. We walk that XML
 *     for paragraphs (`sf:p`), Keynote slides (`key:slide`) and Numbers grids
 *     (`sf:tabular-model` → `sf:grid` → `sf:datasource`).
 *
 *  2. iWork '13+ ("IWA"): `Index/*.iwa` files are Apple's own snappy framing
 *     (chunk header `0x00` + 24-bit little-endian length, then a raw snappy
 *     block — no stream identifier, no CRC) around a stream of protobuf
 *     `ArchiveInfo` + payload pairs. Apple publishes no .proto schema, so we
 *     use the reverse-engineered type ids that matter for text:
 *       - 2001 / 2005 `TSWP.StorageArchive` → field 3 = repeated text string
 *         (Pages body, Keynote text boxes, headers/footers)
 *       - 6005 `TST.TableDataList` (listType 1 = strings) → field 3 entries,
 *         each with the string in field 3 (Numbers / table cell text)
 *     If none of those are found we fall back to a heuristic scan of every
 *     protobuf string field that decodes as readable UTF-8.
 *
 * Fidelity is deliberately limited — styles, layout, images, formulas and the
 * cell grid of modern tables are not reconstructed — so the output always
 * starts with a note saying so, and embeds the document's preview image
 * (when the archive ships one) so the user can see what the original looked
 * like.
 */
import { parseInertDocument } from "../lib/trustedTypes";
import { unzip } from "./zip";

/* ─── Snappy (raw block format) ─────────────────────────────────────── */

function readUvarint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let mul = 1;
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) throw new Error("truncated varint");
    const b = buf[pos++];
    result += (b & 0x7f) * mul;
    if ((b & 0x80) === 0) return [result, pos];
    mul *= 128;
  }
  throw new Error("varint too long");
}

/**
 * Decompress one raw snappy block (preamble varint = uncompressed length,
 * then literal / copy elements). Throws on malformed input.
 */
export function snappyDecompress(src: Uint8Array): Uint8Array {
  const [outLen, start] = readUvarint(src, 0);
  if (outLen > 256 * 1024 * 1024) throw new Error("snappy: block too large");
  const out = new Uint8Array(outLen);
  let ip = start;
  let op = 0;
  while (ip < src.length) {
    const tag = src[ip++];
    const kind = tag & 3;
    if (kind === 0) {
      let len = tag >>> 2;
      if (len >= 60) {
        const extra = len - 59;
        if (ip + extra > src.length) throw new Error("snappy: truncated literal length");
        len = 0;
        for (let i = 0; i < extra; i++) len |= src[ip + i] << (8 * i);
        len = len >>> 0;
        ip += extra;
      }
      len += 1;
      if (ip + len > src.length || op + len > outLen) throw new Error("snappy: literal overruns");
      out.set(src.subarray(ip, ip + len), op);
      ip += len;
      op += len;
      continue;
    }
    let len: number;
    let offset: number;
    if (kind === 1) {
      len = ((tag >>> 2) & 7) + 4;
      if (ip >= src.length) throw new Error("snappy: truncated copy");
      offset = ((tag >>> 5) << 8) | src[ip++];
    } else if (kind === 2) {
      len = (tag >>> 2) + 1;
      if (ip + 2 > src.length) throw new Error("snappy: truncated copy");
      offset = src[ip] | (src[ip + 1] << 8);
      ip += 2;
    } else {
      len = (tag >>> 2) + 1;
      if (ip + 4 > src.length) throw new Error("snappy: truncated copy");
      offset = (src[ip] | (src[ip + 1] << 8) | (src[ip + 2] << 16) | (src[ip + 3] << 24)) >>> 0;
      ip += 4;
    }
    if (offset === 0 || offset > op || op + len > outLen) throw new Error("snappy: bad copy");
    // Byte-by-byte: copies may overlap their own output (run-length style).
    for (let i = 0; i < len; i++, op++) out[op] = out[op - offset];
  }
  if (op !== outLen) throw new Error("snappy: length mismatch");
  return out;
}

/**
 * Undo Apple's IWA framing: a sequence of `[0x00][len:u24le][snappy block]`
 * chunks whose decompressed bodies concatenate into one protobuf stream.
 */
/**
 * Cap on one IWA file's total decompressed size. Real documents' text
 * archives are a few MB; a crafted file could otherwise chain many chunks
 * that each expand toward snappy's per-block limit and exhaust memory.
 */
export const MAX_IWA_DECOMPRESSED = 64 * 1024 * 1024;

/**
 * All IWA components of one document together. Each stays under
 * MAX_IWA_DECOMPRESSED, but many small Snappy streams could otherwise each
 * expand near that cap and, held together, exhaust the tab.
 */
export const MAX_IWA_DOCUMENT_DECOMPRESSED = 128 * 1024 * 1024;

/** The outer package (and a nested Index.zip): per entry and in total. */
export const IWORK_UNZIP_LIMITS = { maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024 };

export function decodeIwa(buf: Uint8Array, maxTotal = MAX_IWA_DECOMPRESSED): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  let p = 0;
  while (p < buf.length) {
    if (p + 4 > buf.length) throw new Error("IWA: truncated chunk header");
    if (buf[p] !== 0) throw new Error(`IWA: unexpected chunk type ${buf[p]}`);
    const len = buf[p + 1] | (buf[p + 2] << 8) | (buf[p + 3] << 16);
    p += 4;
    if (p + len > buf.length) throw new Error("IWA: chunk overruns file");
    // Check the declared size before allocating it.
    const [declared] = readUvarint(buf, p);
    if (total + declared > maxTotal) throw new Error("IWA: decompressed size exceeds limit");
    const part = snappyDecompress(buf.subarray(p, p + len));
    total += part.length;
    parts.push(part);
    p += len;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of parts) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/* ─── Schema-less protobuf ──────────────────────────────────────────── */

export interface PbField {
  num: number;
  wire: number;
  /** Varint / fixed value (wire 0, 1, 5). */
  int?: number;
  /** Length-delimited payload (wire 2). */
  bytes?: Uint8Array;
}

/** Parse a protobuf message without a schema. Returns null if malformed. */
export function parseProtobuf(buf: Uint8Array): PbField[] | null {
  const fields: PbField[] = [];
  let p = 0;
  try {
    while (p < buf.length) {
      let key: number;
      [key, p] = readUvarint(buf, p);
      const wire = key % 8;
      const num = Math.floor(key / 8);
      if (num === 0) return null;
      if (wire === 0) {
        let v: number;
        [v, p] = readUvarint(buf, p);
        fields.push({ num, wire, int: v });
      } else if (wire === 1) {
        if (p + 8 > buf.length) return null;
        fields.push({ num, wire, int: new DataView(buf.buffer, buf.byteOffset + p, 8).getUint32(0, true) });
        p += 8;
      } else if (wire === 5) {
        if (p + 4 > buf.length) return null;
        fields.push({ num, wire, int: new DataView(buf.buffer, buf.byteOffset + p, 4).getUint32(0, true) });
        p += 4;
      } else if (wire === 2) {
        let len: number;
        [len, p] = readUvarint(buf, p);
        if (p + len > buf.length) return null;
        fields.push({ num, wire, bytes: buf.subarray(p, p + len) });
        p += len;
      } else {
        return null; // groups (3/4) and reserved wire types never appear in IWA
      }
    }
  } catch {
    return null;
  }
  return fields;
}

export interface IwaMessage {
  /** Archive identifier (object id). */
  id: number;
  /** TSP message type id (e.g. 2001 = TSWP.StorageArchive). */
  type: number;
  payload: Uint8Array;
}

/**
 * Split a decoded IWA stream into its messages. Each object is
 * `varint(len) ArchiveInfo` followed by one payload per `MessageInfo`
 * (ArchiveInfo: 1 = identifier, 2 = message_infos; MessageInfo: 1 = type,
 * 3 = length).
 */
export function parseIwaMessages(stream: Uint8Array): IwaMessage[] {
  const out: IwaMessage[] = [];
  let p = 0;
  while (p < stream.length) {
    let infoLen: number;
    [infoLen, p] = readUvarint(stream, p);
    if (p + infoLen > stream.length) throw new Error("IWA: ArchiveInfo overruns stream");
    const info = parseProtobuf(stream.subarray(p, p + infoLen));
    p += infoLen;
    if (!info) throw new Error("IWA: malformed ArchiveInfo");
    const id = info.find((f) => f.num === 1 && f.wire === 0)?.int ?? 0;
    for (const mi of info.filter((f) => f.num === 2 && f.bytes)) {
      const m = parseProtobuf(mi.bytes!) ?? [];
      const type = m.find((f) => f.num === 1 && f.wire === 0)?.int ?? 0;
      const length = m.find((f) => f.num === 3 && f.wire === 0)?.int ?? 0;
      if (p + length > stream.length) throw new Error("IWA: payload overruns stream");
      out.push({ id, type, payload: stream.subarray(p, p + length) });
      p += length;
    }
  }
  return out;
}

/* ─── Text extraction ───────────────────────────────────────────────── */

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}

/** Is this string plausibly human-written prose (vs. ids, keys, binary)? */
export function looksLikeText(s: string): boolean {
  if (s.length < 2) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(s)) return false;
  const letters = (s.match(/\p{L}/gu) ?? []).length;
  if (letters < 2 || letters / s.length < 0.5) return false;
  // Single-token identifiers: reverse-DNS keys, style ids, file names, UUIDs.
  if (!/\s/.test(s) && /[._/\\:]|^[A-Z0-9-]{8,}$|\d/.test(s)) return false;
  return true;
}

const STORAGE_TYPES = new Set([2001, 2005]);
const TABLE_DATA_LIST = 6005;

function stripObjectChars(s: string): string {
  // U+FFFC marks inline attachments (images, shapes); U+2028/2029 are
  // line/paragraph separators some versions use instead of "\n".
  return s.replace(/\ufffc/g, "").replace(/[\u2028\u2029\r]/g, "\n");
}

function storageText(payload: Uint8Array): string[] {
  const fields = parseProtobuf(payload) ?? [];
  const text = fields
    .filter((f) => f.num === 3 && f.bytes)
    .map((f) => decodeUtf8(f.bytes!) ?? "")
    .join("");
  return stripObjectChars(text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function tableStrings(payload: Uint8Array): string[] {
  const fields = parseProtobuf(payload) ?? [];
  const listType = fields.find((f) => f.num === 1 && f.wire === 0)?.int;
  if (listType !== undefined && listType !== 1) return [];
  const out: string[] = [];
  for (const entry of fields.filter((f) => f.num === 3 && f.bytes)) {
    const e = parseProtobuf(entry.bytes!) ?? [];
    const str = e.find((f) => f.num === 3 && f.bytes);
    const s = str ? decodeUtf8(str.bytes!) : null;
    if (s && s.trim()) out.push(s.trim());
  }
  return out;
}

/** Fallback: every readable string field, recursing into nested messages. */
function heuristicStrings(payload: Uint8Array, out: string[], depth = 0): void {
  if (depth > 12) return;
  const fields = parseProtobuf(payload);
  if (!fields) return;
  for (const f of fields) {
    if (!f.bytes || f.bytes.length === 0) continue;
    const s = decodeUtf8(f.bytes);
    if (s !== null && looksLikeText(s)) {
      for (const line of stripObjectChars(s).split("\n")) {
        const t = line.trim();
        if (t && looksLikeText(t)) out.push(t);
      }
      continue;
    }
    heuristicStrings(f.bytes, out, depth + 1);
  }
}

export interface IwaExtraction {
  paragraphs: string[];
  tableStrings: string[];
  /** True when no known message type matched and the heuristic scan ran. */
  heuristic: boolean;
}

/**
 * Extract text from a set of decoded IWA files (name → raw `.iwa` bytes).
 * `Index/Document.iwa` is read first so the body precedes slides/sidebars.
 */
export function extractIwaText(
  iwaFiles: Map<string, Uint8Array>,
  maxDocumentBytes = MAX_IWA_DOCUMENT_DECOMPRESSED,
): IwaExtraction {
  const names = [...iwaFiles.keys()].sort((a, b) => {
    const rank = (n: string) => (/Document\.iwa$/.test(n) ? 0 : /Slide/i.test(n) ? 1 : 2);
    return rank(a) - rank(b) || a.localeCompare(b, "en", { numeric: true });
  });
  const messages: IwaMessage[] = [];
  let remaining = maxDocumentBytes;
  for (const name of names) {
    if (remaining <= 0) break; // document-wide budget spent: keep what we have
    try {
      const stream = decodeIwa(iwaFiles.get(name)!, Math.min(MAX_IWA_DECOMPRESSED, remaining));
      remaining -= stream.length;
      messages.push(...parseIwaMessages(stream));
    } catch {
      /* why: skip unreadable (or over-budget) component; others may still yield text */
    }
  }
  const paragraphs: string[] = [];
  const tables: string[] = [];
  for (const m of messages) {
    if (STORAGE_TYPES.has(m.type)) paragraphs.push(...storageText(m.payload));
    else if (m.type === TABLE_DATA_LIST) tables.push(...tableStrings(m.payload));
  }
  if (paragraphs.length || tables.length) {
    return { paragraphs, tableStrings: [...new Set(tables)], heuristic: false };
  }
  const found: string[] = [];
  for (const m of messages) heuristicStrings(m.payload, found);
  // Shared style names etc. repeat across objects; keep first occurrence.
  return { paragraphs: [...new Set(found)], tableStrings: [], heuristic: true };
}

/* ─── XML iWork ('05–'09) ───────────────────────────────────────────── */

const byLocal = (root: Document | Element, local: string): Element[] =>
  Array.from(root.getElementsByTagNameNS("*", local));

function attrLocal(el: Element, local: string): string | null {
  for (const a of Array.from(el.attributes)) if (a.localName === local) return a.value;
  return null;
}

function hasAncestor(el: Element, local: string): boolean {
  for (let p = el.parentElement; p; p = p.parentElement) if (p.localName === local) return true;
  return false;
}

function paragraphText(p: Element): string {
  return (p.textContent ?? "").replace(/\s+/g, " ").trim();
}

function cellValue(cell: Element): string {
  switch (cell.localName) {
    case "t": {
      const ct = byLocal(cell, "ct")[0];
      return (ct ? attrLocal(ct, "s") : null) ?? paragraphText(cell);
    }
    case "n":
      return attrLocal(cell, "v") ?? "";
    case "d":
      return attrLocal(cell, "cell-date") ?? "";
    case "b":
      return attrLocal(cell, "v") === "1" || attrLocal(cell, "v") === "true" ? "TRUE" : "FALSE";
    case "du":
      return attrLocal(cell, "du") ?? attrLocal(cell, "v") ?? "";
    case "f":
    case "o": {
      // Formula / other cells cache their result in a child value cell.
      const inner = Array.from(cell.children).find((c) => ["t", "n", "d", "b"].includes(c.localName));
      return inner ? cellValue(inner) : paragraphText(cell);
    }
    default:
      return paragraphText(cell);
  }
}

const mdCell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function gridToMarkdown(model: Element): string | null {
  const grid = byLocal(model, "grid")[0];
  if (!grid) return null;
  const cols = Number(attrLocal(grid, "numcols") ?? 0);
  const ds = byLocal(grid, "datasource")[0];
  if (!cols || !ds) return null;
  const cells: string[] = [];
  for (const c of Array.from(ds.children)) {
    // `sf:g` (ghost/empty) may carry a repeat count via sf:ct.
    const repeat = c.localName === "g" ? Math.max(1, Number(attrLocal(c, "ct") ?? 1)) : 1;
    const v = c.localName === "g" ? "" : cellValue(c);
    for (let i = 0; i < repeat; i++) cells.push(v);
  }
  if (!cells.length) return null;
  const rows: string[][] = [];
  for (let i = 0; i < cells.length; i += cols) rows.push(cells.slice(i, i + cols));
  while (rows.length && rows[rows.length - 1].every((c) => !c)) rows.pop();
  if (!rows.length) return null;
  const pad = (r: string[]) => Array.from({ length: cols }, (_, i) => mdCell(r[i] ?? ""));
  const name = attrLocal(model, "name");
  return [
    ...(name ? [`### ${name}`, ""] : []),
    "| " + pad(rows[0]).join(" | ") + " |",
    "| " + pad(rows[0]).map(() => "---").join(" | ") + " |",
    ...rows.slice(1).map((r) => "| " + pad(r).join(" | ") + " |"),
  ].join("\n");
}

/** Convert legacy iWork XML (index.xml / index.apxl) to Markdown. */
export function iworkXmlToMarkdown(xml: string): string {
  // Through the inert Trusted Types helper: under `require-trusted-types-for`
  // a plain string would hit the default (DOMPurify) policy and lose the
  // proprietary sf:*/key:* elements this importer reads.
  const doc = parseInertDocument(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) {
    return "> ⚠️ iWork: the document XML could not be parsed.";
  }
  const out: string[] = [];
  const bodyParas = (root: Element | Document) =>
    byLocal(root, "p")
      .filter((p) => !hasAncestor(p, "tabular-model"))
      .map(paragraphText)
      .filter(Boolean);

  const slides = byLocal(doc, "slide").filter((s) => s.namespaceURI?.includes("keynote") || s.prefix === "key");
  if (slides.length) {
    slides.forEach((s, i) => {
      const paras = bodyParas(s);
      out.push(`## Slide ${i + 1}${paras[0] ? `: ${paras[0]}` : ""}`);
      if (paras.length > 1) out.push(paras.slice(1).join("\n\n"));
    });
  } else {
    const paras = bodyParas(doc);
    if (paras.length) out.push(paras.join("\n\n"));
  }
  for (const model of byLocal(doc, "tabular-model")) {
    const table = gridToMarkdown(model);
    if (table) out.push(table);
  }
  return out.join("\n\n");
}

/* ─── Entry point ───────────────────────────────────────────────────── */

const APP_NAMES: Record<string, string> = {
  pages: "Apple Pages",
  numbers: "Apple Numbers",
  key: "Apple Keynote",
};

export async function gunzip(data: Uint8Array, maxBytes = IWORK_UNZIP_LIMITS.maxEntryBytes): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const src = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(data);
      c.close();
    },
  });
  const reader = src.pipeThrough(ds).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      // A small crafted gzip member can expand enormously: stop at the cap.
      if (total > maxBytes) {
        await reader.cancel().catch(() => { /* why: the read is abandoned and the size error below is what the caller sees */ });
        throw new Error("gzip entry exceeds the size limit");
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Largest preview we inline as a data: URI (keeps the doc reasonable). */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

function previewMarkdown(files: Map<string, Uint8Array>): string | null {
  const candidates = ["preview.jpg", "QuickLook/Thumbnail.jpg", "preview-web.jpg", "preview-micro.jpg"];
  for (const name of candidates) {
    const bytes = files.get(name);
    if (bytes && bytes.length > 0 && bytes.length <= MAX_PREVIEW_BYTES) {
      return `![Document preview](data:image/jpeg;base64,${toBase64(bytes)})`;
    }
  }
  return null;
}

export interface IworkImportOptions {
  /** Used to text-extract `QuickLook/Preview.pdf` when nothing else yields text. */
  pdfFallback?: (pdf: Uint8Array) => Promise<string>;
}

/**
 * Import an iWork document. `ext` is "pages", "numbers" or "key".
 * Always returns Markdown (errors become a visible ⚠️ note).
 */
export async function iworkToMarkdown(
  buffer: ArrayBufferLike,
  ext: string,
  opts: IworkImportOptions = {},
): Promise<string> {
  const app = APP_NAMES[ext] ?? "Apple iWork";
  let files: Map<string, Uint8Array>;
  try {
    files = await unzip(buffer, IWORK_UNZIP_LIMITS);
  } catch (err) {
    return `> ⚠️ Could not read ${app} file: ${(err as Error).message}. If it is a package folder, re-save it from ${app} as a single file.`;
  }
  // iWork '13 packages kept the IWA files in a nested Index.zip.
  const nested = files.get("Index.zip");
  if (nested) {
    try {
      const inner = await unzip(nested.slice().buffer, IWORK_UNZIP_LIMITS);
      for (const [k, v] of inner) files.set(k.startsWith("Index/") ? k : `Index/${k}`, v);
    } catch {
      /* why: fall through to whatever else the archive has */
    }
  }

  const preview = previewMarkdown(files);

  // 1. Legacy XML iWork.
  const xmlName = ["index.xml", "index.apxl", "index.xml.gz", "index.apxl.gz"].find((n) => files.has(n));
  if (xmlName) {
    let bytes = files.get(xmlName)!;
    try {
      if (xmlName.endsWith(".gz")) bytes = await gunzip(bytes);
      const body = iworkXmlToMarkdown(new TextDecoder().decode(bytes));
      const note = `> ℹ️ Imported from ${app} (iWork '09 XML format). Text and tables were kept; styles, images and layout were not.`;
      return [note, preview, body || "> ⚠️ No text found in this document."].filter(Boolean).join("\n\n") + "\n";
    } catch (err) {
      return `> ⚠️ Could not read ${app} XML: ${(err as Error).message}`;
    }
  }

  // 2. Modern IWA.
  const iwa = new Map([...files].filter(([n]) => /\.iwa$/i.test(n)));
  const parts: string[] = [];
  let heuristic = false;
  if (iwa.size) {
    const ex = extractIwaText(iwa);
    heuristic = ex.heuristic;
    if (ex.paragraphs.length) parts.push(ex.paragraphs.join("\n\n"));
    if (ex.tableStrings.length) {
      parts.push("## Table text\n\n" + ex.tableStrings.map((s) => `- ${s}`).join("\n"));
    }
  }
  let usedPdf = false;
  const pdf = files.get("QuickLook/Preview.pdf");
  if (!parts.length && pdf && opts.pdfFallback) {
    const text = await opts.pdfFallback(pdf);
    if (text && !text.startsWith("> ⚠️")) {
      parts.push(text);
      usedPdf = true;
    }
  }
  if (!iwa.size && !pdf && !preview) {
    return `> ⚠️ This doesn't look like an ${app} document (no index.xml, Index/*.iwa or preview found).`;
  }

  const how = usedPdf
    ? "text came from the embedded QuickLook PDF preview"
    : heuristic
      ? "text was recovered heuristically and may include stray labels or miss some content"
      : "body text was extracted";
  const note =
    `> ℹ️ Imported from ${app} (iWork IWA format) — limited fidelity: ${how}. ` +
    "Styles, images, layout and table structure are not preserved" +
    (preview ? "; the original's preview image is shown below." : ".");
  return [note, preview, parts.join("\n\n") || "> ⚠️ No readable text found in this document."]
    .filter(Boolean)
    .join("\n\n") + "\n";
}
