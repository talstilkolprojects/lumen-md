/**
 * A small tar writer and reader (POSIX ustar with pax headers), for backup
 * archives (plan W1.6). Every name goes into a pax `path` record as UTF-8, so
 * Hebrew and long paths survive, and `tar`, `bsdtar` or Python's `tarfile`
 * open the archive without Lumen.
 */

const BLOCK = 512;
const enc = new TextEncoder();
const dec = new TextDecoder();

export interface TarEntry {
  path: string;
  data: Uint8Array;
  /** Seconds since the epoch. */
  mtime: number;
}

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function header(name: string, size: number, mtime: number, type: "0" | "x"): Uint8Array {
  const h = new Uint8Array(BLOCK);
  const put = (s: string, at: number, len: number) => h.set(enc.encode(s).subarray(0, len), at);
  put(name, 0, 100);
  put(octal(0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(Math.max(0, Math.floor(mtime)), 12), 136, 12);
  put("        ", 148, 8); // checksum placeholder
  put(type, 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(octal(sum, 7) + " ", 148, 8);
  return h;
}

/** One pax record: "<len> path=<value>\n", where len counts the whole record. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const n = enc.encode(body).length;
  let total = n + 1;
  while (String(total).length + n !== total) total = String(total).length + n;
  return `${total}${body}`;
}

const pad = (n: number) => (BLOCK - (n % BLOCK)) % BLOCK;

export function writeTar(entries: TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    const pax = enc.encode(paxRecord("path", e.path));
    parts.push(header("PaxHeader", pax.length, e.mtime, "x"), pax, new Uint8Array(pad(pax.length)));
    // The ustar name field gets an ASCII fallback; the pax record is what counts.
    const fallback = e.path.replace(/[^\x20-\x7e]/g, "_").slice(-99);
    parts.push(header(fallback, e.data.length, e.mtime, "0"), e.data, new Uint8Array(pad(e.data.length)));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarError";
  }
}

function readOctal(b: Uint8Array): number {
  const s = dec.decode(b).replace(/\0.*$/s, "").trim();
  return s ? parseInt(s, 8) : 0;
}

/** Every regular file in the archive (pax `path` records honoured). */
export function readTar(bytes: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  let at = 0;
  let paxPath: string | null = null;
  while (at + BLOCK <= bytes.length) {
    const h = bytes.subarray(at, at + BLOCK);
    if (h.every((x) => x === 0)) break;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== readOctal(h.subarray(148, 156))) throw new TarError("bad header checksum");
    const size = readOctal(h.subarray(124, 136));
    const type = String.fromCharCode(h[156] || 48);
    const body = bytes.subarray(at + BLOCK, at + BLOCK + size);
    if (body.length !== size) throw new TarError("truncated archive");
    at += BLOCK + size + pad(size);
    if (type === "x") {
      const text = dec.decode(body);
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text);
      paxPath = m ? m[1] : null;
      continue;
    }
    if (type === "0") {
      const name = paxPath ?? dec.decode(h.subarray(0, 100)).replace(/\0.*$/s, "");
      out.push({ path: name, data: body.slice(), mtime: readOctal(h.subarray(136, 148)) });
    }
    paxPath = null;
  }
  return out;
}
