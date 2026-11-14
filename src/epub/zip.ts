/**
 * A small read-only ZIP reader for EPUB files (plan W1.14) — no package:
 * the central directory is parsed here and deflated entries are inflated
 * with the platform's DecompressionStream("deflate-raw") (all current
 * browsers, Node 18+). Stored (method 0) and deflated (method 8) entries
 * are supported; ZIP64, encryption and multi-disk archives are refused.
 */

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  /** Offset of the local file header. */
  offset: number;
}

export interface ZipArchive {
  entries: Map<string, ZipEntry>;
  read(name: string): Promise<Uint8Array>;
  text(name: string): Promise<string>;
}

export const EOCD = 0x06054b50;
export const CENTRAL = 0x02014b50;
export const LOCAL = 0x04034b50;

/** Entry names as stored, percent-decoding not applied; `./` and leading `/` removed. */
export function normalizeZipPath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function readZip(bytes: Uint8Array): ZipArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record is in the last 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP file");
  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("ZIP64 is not supported");
  const decoder = new TextDecoder();
  const entries = new Map<string, ZipEntry>();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== CENTRAL) throw new Error("damaged ZIP directory");
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (flags & 1) throw new Error("encrypted ZIP entries are not supported");
    if (!name.endsWith("/")) entries.set(normalizeZipPath(name), { name, method, compressedSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const read = async (name: string): Promise<Uint8Array> => {
    const e = entries.get(normalizeZipPath(name));
    if (!e) throw new Error(`missing in the book: ${name}`);
    if (view.getUint32(e.offset, true) !== LOCAL) throw new Error("damaged ZIP entry");
    const start = e.offset + 30 + view.getUint16(e.offset + 26, true) + view.getUint16(e.offset + 28, true);
    const raw = bytes.subarray(start, start + e.compressedSize);
    if (e.method === 0) return raw.slice();
    if (e.method === 8) return inflateRaw(raw);
    throw new Error(`unsupported ZIP compression ${e.method}`);
  };
  return { entries, read, text: async (name) => decoder.decode(await read(name)) };
}
