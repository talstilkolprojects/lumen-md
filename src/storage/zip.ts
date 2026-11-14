/**
 * Minimal ZIP reader/writer — zero external dependencies.
 *
 * Office formats (DOCX, ODT, PPTX, XLSX) and EPUB are ZIP archives of XML.
 * Browsers don't ship a ZIP API, but they DO ship `DecompressionStream` /
 * `CompressionStream` ("deflate-raw"), which is exactly the codec ZIP uses.
 * This module reads the central directory and inflates entries on demand, and
 * writes STORE/DEFLATE archives — enough for real .docx import and export
 * without pulling in JSZip (~100KB) or mammoth.
 *
 * Not supported: ZIP64, encryption, multi-disk. Documents never need them.
 */

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

function bytesToStream(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>, maxBytes = Number.POSITIVE_INFINITY): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > maxBytes) {
        // Stop inflating a ZIP bomb as soon as it crosses the limit.
        await reader.cancel().catch(() => { /* why: the read is abandoned and the size error below is what the caller sees */ });
        throw new Error("ZIP entry exceeds the size limit");
      }
      chunks.push(value);
    }
  }
  const len = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

type ByteTransform = ReadableWritablePair<Uint8Array, Uint8Array>;

async function inflateRaw(data: Uint8Array, maxBytes?: number): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw") as unknown as ByteTransform;
  return drain(bytesToStream(data).pipeThrough(ds), maxBytes);
}

export interface UnzipLimits {
  /** Largest inflated size of one entry (bytes). */
  maxEntryBytes?: number;
  /** Largest inflated size of all entries together (bytes). */
  maxTotalBytes?: number;
}

/**
 * Defaults for every import: generous for real documents, but a few-KB
 * ZIP bomb can no longer inflate to gigabytes and exhaust the tab.
 */
export const DEFAULT_UNZIP_LIMITS: Required<UnzipLimits> = {
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
};

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw") as unknown as ByteTransform;
  return drain(bytesToStream(data).pipeThrough(cs));
}

/**
 * Inflate every entry in a ZIP archive into a name → bytes map.
 * Directory entries (names ending in "/") are skipped.
 */
export async function unzip(
  buffer: ArrayBufferLike,
  limits: UnzipLimits = {},
): Promise<Map<string, Uint8Array>> {
  const maxEntry = limits.maxEntryBytes ?? DEFAULT_UNZIP_LIMITS.maxEntryBytes;
  const maxTotal = limits.maxTotalBytes ?? DEFAULT_UNZIP_LIMITS.maxTotalBytes;
  let total = 0;
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // Find the End Of Central Directory record by scanning backwards.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a ZIP archive (no EOCD record)");

  const entryCount = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true); // central directory offset

  const out = new Map<string, Uint8Array>();
  for (let n = 0; n < entryCount; n++) {
    if (view.getUint32(ptr, true) !== CEN_SIG) break;
    const method = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    ptr += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;

    // Read the local header to locate the data start (its name/extra lengths
    // can differ from the central directory's).
    const lhNameLen = view.getUint16(localOffset + 26, true);
    const lhExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    const compressed = bytes.subarray(dataStart, dataStart + compSize);

    let data: Uint8Array;
    if (method === 0) {
      if (compressed.length > maxEntry) throw new Error(`ZIP entry ${name} exceeds the size limit`);
      data = compressed.slice();
    } else if (method === 8) {
      data = await inflateRaw(compressed, Math.min(maxEntry, maxTotal - total));
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    }
    total += data.length;
    if (total > maxTotal) throw new Error("ZIP archive exceeds the total size limit");
    out.set(name, data);
  }
  return out;
}

/** Read a single entry as UTF-8 text, or null if absent. */
export async function unzipText(buffer: ArrayBufferLike, name: string): Promise<string | null> {
  const files = await unzip(buffer);
  const bytes = files.get(name);
  return bytes ? new TextDecoder().decode(bytes) : null;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipInput {
  name: string;
  data: string | Uint8Array;
  /** Force stored (no compression). Defaults to deflate for files > 64 bytes. */
  store?: boolean;
}

/**
 * Build a ZIP archive. Returns a Uint8Array. Entries above a small threshold
 * are deflated; tiny entries (e.g. the OOXML `[Content_Types]` part) are
 * stored to keep the output deterministic and cheap.
 */
export async function zip(inputs: ZipInput[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const input of inputs) {
    const raw = typeof input.data === "string" ? enc.encode(input.data) : input.data;
    const nameBytes = enc.encode(input.name);
    const crc = crc32(raw);
    const useStore = input.store ?? raw.length <= 64;
    const body = useStore ? raw : await deflateRaw(raw);
    const method = useStore ? 0 : 8;

    const local = new Uint8Array(30 + nameBytes.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    // Bit 11: the name is UTF-8 (Hebrew file names open correctly everywhere).
    const flags = /[^\x20-\x7e]/.test(input.name) ? 0x0800 : 0;
    lv.setUint16(6, flags, true); // flags
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0x21, true); // mod date (1980-01-01)
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    local.set(body, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, CEN_SIG, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true); // local header offset
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIG, true);
  ev.setUint16(8, inputs.length, true);
  ev.setUint16(10, inputs.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + 22;
  const result = new Uint8Array(total);
  let p = 0;
  for (const l of locals) {
    result.set(l, p);
    p += l.length;
  }
  for (const c of centrals) {
    result.set(c, p);
    p += c.length;
  }
  result.set(eocd, p);
  return result;
}
