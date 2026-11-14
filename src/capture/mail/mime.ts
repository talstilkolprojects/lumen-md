/**
 * A small MIME reader for imported mail (plan W5.18): .eml files and the
 * messages of an .mbox. Headers are unfolded and their RFC 2047
 * encoded-words decoded (B and Q, any charset TextDecoder knows), RFC 2231
 * parameters too (filename*=utf-8''…). Bodies are un-base64'd or
 * un-quoted-printable'd, then decoded with their charset: windows-1255 and
 * ISO-8859-8-I are logical Hebrew; ISO-8859-8 is visual by definition and
 * is turned around when it really reads backwards (./visual.ts). Raw 8-bit
 * headers (no encoded-words) are read as UTF-8 when valid, else as the
 * message's charset, else windows-1255.
 *
 * Works on "binary strings" (one char per byte) while parsing, so byte
 * offsets and string offsets are the same.
 */
import { looksVisual, visualToLogical } from "./visual";

export interface MailAttachment {
  name: string;
  type: string;
  bytes: Uint8Array;
  cid?: string;
}

export interface MailMessage {
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: Date | null;
  messageId: string;
  inReplyTo: string;
  references: string[];
  /** Gmail labels (X-Gmail-Labels in a Takeout mbox). */
  labels: string[];
  text: string | null;
  html: string | null;
  attachments: MailAttachment[];
  /** Charsets the body parts were declared in (for the report). */
  charsets: string[];
}

export const toBinary = (b: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
};

export const fromBinary = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

const ALIASES: Record<string, string> = {
  "cp1255": "windows-1255",
  "x-cp1255": "windows-1255",
  "ms-hebr": "windows-1255",
  "hebrew": "iso-8859-8",
  "iso_8859-8": "iso-8859-8",
  "iso-8859-8-e": "iso-8859-8",
  "visual": "iso-8859-8",
  "logical": "iso-8859-8-i",
  "csisolatinhebrew": "iso-8859-8",
  "ascii": "us-ascii",
  "utf8": "utf-8",
  "unicode-1-1-utf-8": "utf-8",
};

const norm = (cs: string) => {
  const c = cs.trim().replace(/^["']|["']$/g, "").toLowerCase();
  return ALIASES[c] ?? c;
};

/** Decode bytes in `charset`; ISO-8859-8 (visual) is turned around when it reads backwards. Unknown charsets fall back to UTF-8, then windows-1255. */
export function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  const cs = norm(charset || "us-ascii");
  let text: string;
  try {
    if (cs === "us-ascii" || cs === "utf-8") {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        // Undeclared 8-bit text from an Israeli client: windows-1255 is the usual one.
        text = new TextDecoder("windows-1255").decode(bytes);
      }
    } else {
      text = new TextDecoder(cs).decode(bytes);
    }
  } catch {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder("windows-1255").decode(bytes);
    }
  }
  if (cs === "iso-8859-8" && looksVisual(text)) text = visualToLogical(text);
  return text;
}

function b64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
  const pad = clean.length % 4 === 1 ? clean.slice(0, -1) : clean;
  try {
    return fromBinary(atob(pad + "===".slice((pad.length + 3) % 4)));
  } catch {
    return new Uint8Array();
  }
}

function qp(s: string, header = false): Uint8Array {
  const t = header ? s.replace(/_/g, " ") : s.replace(/=\r?\n/g, "");
  return fromBinary(t.replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))));
}

/** RFC 2047 encoded-words in a header (adjacent words joined, the space between them dropped). */
export function decodeWords(value: string, fallback?: string): string {
  const raw = value.replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?[^?]+\?[BbQq]\?)/g, "$1");
  const parts: string[] = [];
  let last = 0;
  const re = /=\?([^?*]+)(?:\*[^?]*)?\?([BbQq])\?([^?]*)\?=/g;
  let m: RegExpExecArray | null;
  // Consecutive words in the same charset are joined as bytes first: a multi-byte character may be split across them.
  let pending: { cs: string; bytes: number[] } | null = null;
  const flushPending = () => {
    if (pending) parts.push(decodeCharset(new Uint8Array(pending.bytes), pending.cs));
    pending = null;
  };
  while ((m = re.exec(raw))) {
    if (m.index > last) {
      flushPending();
      parts.push(rawHeader(raw.slice(last, m.index), fallback));
    }
    const bytes = m[2].toUpperCase() === "B" ? b64(m[3]) : qp(m[3], true);
    const cs = norm(m[1]);
    if (pending && pending.cs === cs) pending.bytes.push(...bytes);
    else {
      flushPending();
      pending = { cs, bytes: [...bytes] };
    }
    last = re.lastIndex;
  }
  flushPending();
  if (last < raw.length) parts.push(rawHeader(raw.slice(last), fallback));
  return parts.join("").replace(/\s+/g, " ").trim();
}

/** A header part without encoded-words: plain ASCII, or raw 8-bit bytes. */
function rawHeader(s: string, fallback?: string): string {
  if (!/[\x80-\xff]/.test(s)) return s;
  const bytes = fromBinary(s);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return decodeCharset(bytes, fallback && norm(fallback) !== "utf-8" ? fallback : "windows-1255");
  }
}

export interface Headers {
  get(name: string): string | undefined;
  all(name: string): string[];
}

function parseHeaders(block: string): Headers {
  const map = new Map<string, string[]>();
  for (const line of block.replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ").split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    map.set(k, [...(map.get(k) ?? []), line.slice(i + 1).trim()]);
  }
  return { get: (n) => map.get(n.toLowerCase())?.[0], all: (n) => map.get(n.toLowerCase()) ?? [] };
}

/** `text/plain; charset="windows-1255"; format=flowed` → { value, params } (RFC 2231 continuations and charsets too). */
export function parseParams(v: string | undefined): { value: string; params: Record<string, string> } {
  if (!v) return { value: "", params: {} };
  const [value, ...rest] = v.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const params: Record<string, string> = {};
  const ext: Record<string, Array<{ n: number; v: string; enc: boolean }>> = {};
  for (const p of rest) {
    const i = p.indexOf("=");
    if (i < 0) continue;
    const key = p.slice(0, i).trim().toLowerCase();
    let val = p.slice(i + 1).trim().replace(/^"|"$/g, "");
    const m = /^([^*]+)\*(\d+)?(\*)?$/.exec(key);
    if (m) {
      (ext[m[1]] ??= []).push({ n: Number(m[2] ?? 0), v: val, enc: !!m[3] || (!m[2] && key.endsWith("*")) });
      continue;
    }
    val = val.replace(/\\(.)/g, "$1");
    params[key] = val;
  }
  for (const [k, list] of Object.entries(ext)) {
    list.sort((a, b) => a.n - b.n);
    let cs = "utf-8";
    let bin = "";
    for (const [i, part] of list.entries()) {
      let v = part.v;
      if (i === 0 && part.enc) {
        const q = /^([^']*)'[^']*'(.*)$/.exec(v);
        if (q) {
          cs = q[1] || cs;
          v = q[2];
        }
      }
      bin += part.enc ? v.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))) : v;
    }
    params[k] = decodeCharset(fromBinary(bin), cs);
  }
  return { value: value.trim().toLowerCase(), params };
}

function split(bin: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(bin);
  return m ? { head: bin.slice(0, m.index), body: bin.slice(m.index + m[0].length) } : { head: bin, body: "" };
}

function decodeBody(body: string, cte: string | undefined): Uint8Array {
  const e = (cte ?? "").trim().toLowerCase();
  if (e === "base64") return b64(body);
  if (e === "quoted-printable") return qp(body);
  return fromBinary(body);
}

function ids(v: string | undefined): string[] {
  return (v ?? "").match(/<[^>]+>/g)?.map((x) => x.slice(1, -1).trim()) ?? [];
}

function walk(bin: string, msg: MailMessage, fallbackCs: string | undefined, depth: number): void {
  const { head, body } = split(bin);
  const h = parseHeaders(head);
  const ct = parseParams(h.get("content-type") ?? "text/plain");
  const disp = parseParams(h.get("content-disposition"));
  const type = ct.value || "text/plain";
  if (type.startsWith("multipart/") && ct.params.boundary && depth < 20) {
    const b = "--" + ct.params.boundary;
    const chunks = body.split(new RegExp(`(?:^|\\r?\\n)${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?[ \\t]*(?=\\r?\\n|$)`));
    // chunks[0] is the preamble, the last one the epilogue after the closing boundary.
    for (const c of chunks.slice(1)) {
      const part = c.replace(/^\r?\n/, "");
      if (part.trim()) walk(part, msg, ct.params.charset ?? fallbackCs, depth + 1);
    }
    return;
  }
  const bytes = decodeBody(body, h.get("content-transfer-encoding"));
  const name = decodeWords(disp.params.filename ?? ct.params.name ?? "", fallbackCs);
  const inlineText = (type === "text/plain" || type === "text/html") && disp.value !== "attachment" && !name;
  if (inlineText) {
    const cs = ct.params.charset ?? fallbackCs;
    msg.charsets.push(norm(cs ?? "us-ascii"));
    const text = decodeCharset(bytes, cs);
    if (type === "text/plain") msg.text = msg.text === null ? text : `${msg.text}\n\n${text}`;
    else msg.html = msg.html === null ? text : `${msg.html}\n${text}`;
    return;
  }
  const ext = type === "message/rfc822" ? ".eml" : "";
  const cid = ids(h.get("content-id"))[0];
  msg.attachments.push({ name: name || `${cid ?? "attachment"}${ext}`, type, bytes, ...(cid ? { cid } : {}) });
}

/** One message (an .eml, or one message of an mbox) → its parts. */
export function parseMail(bytes: Uint8Array): MailMessage {
  const bin = toBinary(bytes);
  const { head } = split(bin);
  const h = parseHeaders(head);
  const cs = parseParams(h.get("content-type")).params.charset;
  const date = h.get("date") ? new Date(h.get("date")!.replace(/\s*\([^)]*\)\s*$/, "")) : null;
  const msg: MailMessage = {
    subject: decodeWords(h.get("subject") ?? "", cs),
    from: decodeWords(h.get("from") ?? "", cs),
    to: decodeWords(h.get("to") ?? "", cs),
    cc: decodeWords(h.get("cc") ?? "", cs),
    date: date && !Number.isNaN(date.getTime()) ? date : null,
    messageId: ids(h.get("message-id"))[0] ?? "",
    inReplyTo: ids(h.get("in-reply-to"))[0] ?? "",
    references: ids(h.get("references")),
    labels: (decodeWords(h.get("x-gmail-labels") ?? "", cs).match(/("[^"]*"|[^,]+)/g) ?? []).map((l) => l.replace(/^\s*"?|"?\s*$/g, "")).filter(Boolean),
    text: null,
    html: null,
    attachments: [],
    charsets: [],
  };
  walk(bin, msg, cs, 0);
  return msg;
}

/** The display name of an address ("טל כהן <tal@example.com>" → "טל כהן"), or the address. */
export function displayName(addr: string): string {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(addr);
  if (m) return m[1].trim() || m[2].trim();
  return addr.trim();
}
