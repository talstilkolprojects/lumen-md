/**
 * Remove what a photo says about where and when it was taken, and on what,
 * before it goes into a note (plan W5.11, journalist mode).
 *
 * Cameras and phones write EXIF (GPS position, time, camera serial number,
 * owner name), XMP, IPTC and text chunks into JPEG, PNG and WebP files. All
 * of it is removed; the pixels are not touched (no re-encoding, no quality
 * loss). What is kept:
 *   - JPEG: JFIF (APP0), the ICC colour profile (APP2), Adobe's colour
 *     transform (APP14), and the EXIF orientation — rewritten as an EXIF
 *     block holding that one tag, so a portrait photo still stands upright;
 *   - PNG: every chunk but eXIf, tEXt, zTXt, iTXt and tIME;
 *   - WebP: every chunk but EXIF and XMP (the VP8X flags are corrected).
 * Other formats (GIF, SVG, HEIC, AVIF) come back unchanged, with
 * `format: null`.
 *
 * Fail closed (review 12.11): a JPEG, PNG or WebP that can't be parsed throws
 * ImageMetadataError instead of coming back as it was. The async helpers
 * (cleanImageBytes, cleanImageFile) then re-encode it through a canvas, which
 * keeps only the pixels, or refuse it when no canvas is available. Data after
 * the image's end (a JPEG's EOI, a PNG's IEND, a WebP's RIFF size) goes too:
 * that is where an MPF second image or a Motion Photo video sits. In a JPEG,
 * stray bytes between segments are skipped as decoders skip them, segments
 * between scans are cleaned like the header's, and APP2 is kept only when it
 * is an ICC profile (an MPF index is APP2 too).
 */

export interface StripResult {
  bytes: Uint8Array<ArrayBuffer>;
  /** Image format that was cleaned, or null when it is not one we clean. */
  format: "jpeg" | "png" | "webp" | null;
  /** What was taken out, e.g. ["EXIF", "GPS", "XMP"]. Empty when nothing was there. */
  removed: string[];
}

/** A JPEG, PNG or WebP whose structure could not be read: its metadata can't be removed in place. */
export class ImageMetadataError extends Error {
  constructor(format: string, why: string) {
    super(`This ${format.toUpperCase()} photo could not be read (${why}), so its metadata could not be removed.`);
    this.name = "ImageMetadataError";
  }
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

/** Does this EXIF (TIFF) block have a GPS sub-IFD, and which orientation does it give? */
function readExif(tiff: Uint8Array): { gps: boolean; orientation: number | null } {
  if (tiff.length < 8) return { gps: false, orientation: null };
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!le && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return { gps: false, orientation: null };
  const u16 = (o: number) => (le ? tiff[o] | (tiff[o + 1] << 8) : (tiff[o] << 8) | tiff[o + 1]);
  const u32 = (o: number) => (le ? (tiff[o] | (tiff[o + 1] << 8) | (tiff[o + 2] << 16)) + tiff[o + 3] * 0x1000000 : tiff[o] * 0x1000000 + ((tiff[o + 1] << 16) | (tiff[o + 2] << 8) | tiff[o + 3]));
  const ifd0 = u32(4);
  if (ifd0 + 2 > tiff.length) return { gps: false, orientation: null };
  const count = u16(ifd0);
  let gps = false;
  let orientation: number | null = null;
  for (let i = 0; i < count; i++) {
    const e = ifd0 + 2 + i * 12;
    if (e + 12 > tiff.length) break;
    const tag = u16(e);
    if (tag === 0x8825) gps = true;
    if (tag === 0x0112) orientation = u16(e + 8);
  }
  return { gps, orientation };
}

/** A minimal EXIF APP1 segment holding only the Orientation tag. */
function orientationSegment(orientation: number): Uint8Array {
  const body = [
    ...[0x45, 0x78, 0x69, 0x66, 0, 0], // "Exif\0\0"
    ...[0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8], // big-endian TIFF, IFD0 at 8
    ...[0, 1], // one entry
    ...[0x01, 0x12, 0, 3, 0, 0, 0, 1, (orientation >> 8) & 0xff, orientation & 0xff, 0, 0], // Orientation, SHORT, 1
    ...[0, 0, 0, 0], // no next IFD
  ];
  const len = body.length + 2;
  return new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff, ...body]);
}

/** What to do with one marker segment (APPn, COM, DQT, DHT …): keep it, or drop it and say what it was. */
function jpegSegment(marker: number, data: Uint8Array, removed: Set<string>, found: { orientation: number | null }): boolean {
  if (marker === 0xe1) {
    if (ascii(data, 0, 6) === "Exif\0\0") {
      removed.add("EXIF");
      const ex = readExif(data.subarray(6));
      if (ex.gps) removed.add("GPS");
      if (ex.orientation && ex.orientation !== 1 && found.orientation === null) found.orientation = ex.orientation;
    } else if (ascii(data, 0, 28) === "http://ns.adobe.com/xap/1.0/") removed.add("XMP");
    else removed.add("APP1");
    return false;
  }
  if (marker === 0xe2) {
    if (ascii(data, 0, 12) === "ICC_PROFILE\0") return true;
    removed.add(ascii(data, 0, 4) === "MPF\0" ? "MPF" : "APP2"); // MPF: the index of a second image
    return false;
  }
  if (marker === 0xed) {
    removed.add("IPTC");
    return false;
  }
  if (marker === 0xfe) {
    removed.add("comment");
    return false;
  }
  if (marker >= 0xe3 && marker <= 0xef && marker !== 0xee) {
    removed.add(`APP${marker - 0xe0}`); // APP3–APP13, APP15: maker notes, Photoshop, FlashPix …
    return false;
  }
  return true;
}

function stripJpeg(b: Uint8Array): StripResult | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  const removed = new Set<string>();
  const found = { orientation: null as number | null };
  let i = 2;
  let ended = false;
  while (i < b.length) {
    if (b[i] !== 0xff) {
      // Stray bytes before a marker: decoders skip them ("extraneous bytes"), and so does this.
      while (i < b.length && b[i] !== 0xff) i++;
      continue;
    }
    if (i + 1 >= b.length) break;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xd9) {
      parts.push(b.subarray(i, i + 2));
      i += 2;
      ended = true;
      break;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (marker === 0xd8 || marker === 0x00) throw new ImageMetadataError("jpeg", "unexpected marker");
    if (i + 4 > b.length) throw new ImageMetadataError("jpeg", "cut off");
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) throw new ImageMetadataError("jpeg", "bad segment length");
    const seg = b.subarray(i, i + 2 + len);
    if (jpegSegment(marker, b.subarray(i + 4, i + 2 + len), removed, found)) parts.push(seg);
    i += 2 + len;
    if (marker === 0xda) {
      // Entropy-coded data runs to the next marker that isn't a stuffed 0xFF00 or a restart marker.
      const start = i;
      while (i + 1 < b.length && !(b[i] === 0xff && b[i + 1] !== 0x00 && !(b[i + 1] >= 0xd0 && b[i + 1] <= 0xd7))) i++;
      if (i + 1 >= b.length) i = b.length; // no end marker: a cut-off scan, kept as it is
      parts.push(b.subarray(start, i));
    }
  }
  // After EOI: an MPF second image, a Motion Photo video, anything appended. It goes.
  if (ended && i < b.length) removed.add("trailer");
  if (found.orientation) parts.splice(1, 0, orientationSegment(found.orientation));
  return { bytes: concat(parts), format: "jpeg", removed: [...removed] };
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_DROP: Record<string, string> = { eXIf: "EXIF", tEXt: "text", zTXt: "text", iTXt: "text", tIME: "time" };

function stripPng(b: Uint8Array): StripResult | null {
  if (b.length < 8 || PNG_SIG.some((v, k) => b[k] !== v)) return null;
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  const removed = new Set<string>();
  let i = 8;
  while (i + 12 <= b.length) {
    const len = ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
    const type = ascii(b, i + 4, 4);
    const end = i + 12 + len;
    if (end > b.length) throw new ImageMetadataError("png", "bad chunk length");
    const what = PNG_DROP[type];
    if (what) {
      removed.add(what);
      if (type === "eXIf" && readExif(b.subarray(i + 8, i + 8 + len)).gps) removed.add("GPS");
      if (type === "iTXt" && /XML:com\.adobe\.xmp/.test(ascii(b, i + 8, Math.min(len, 32)))) removed.add("XMP");
    } else parts.push(b.subarray(i, end));
    i = end;
    if (type === "IEND") {
      // After IEND: anything appended (another file, a video). It goes.
      if (i < b.length) removed.add("trailer");
      break;
    }
  }
  return { bytes: concat(parts), format: "png", removed: [...removed] };
}

function stripWebp(b: Uint8Array): StripResult | null {
  if (b.length < 12 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const parts: Uint8Array[] = [];
  const removed = new Set<string>();
  let vp8x: Uint8Array | null = null;
  // The RIFF size bounds the file: bytes after it are appended data, and go.
  const riffEnd = Math.min(b.length, 8 + ((b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24)) >>> 0));
  if (riffEnd < b.length) removed.add("trailer");
  let i = 12;
  while (i + 8 <= riffEnd) {
    const type = ascii(b, i, 4);
    const len = (b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24)) >>> 0;
    const end = i + 8 + len + (len & 1);
    if (end > riffEnd + 1) throw new ImageMetadataError("webp", "bad chunk length");
    if (type === "EXIF") {
      removed.add("EXIF");
      const data = b.subarray(i + 8, i + 8 + len);
      const tiff = ascii(data, 0, 6) === "Exif\0\0" ? data.subarray(6) : data;
      if (readExif(tiff).gps) removed.add("GPS");
    } else if (type === "XMP ") removed.add("XMP");
    else {
      const chunk = b.slice(i, Math.min(end, riffEnd));
      if (type === "VP8X") vp8x = chunk;
      parts.push(chunk);
    }
    i = end;
  }
  // VP8X flags: bit 3 EXIF, bit 2 XMP.
  if (vp8x && vp8x.length > 8) vp8x[8] &= ~0x0c;
  const body = concat(parts);
  const head = new Uint8Array(12);
  head.set(b.subarray(0, 12));
  const size = body.length + 4;
  head[4] = size & 0xff;
  head[5] = (size >> 8) & 0xff;
  head[6] = (size >> 16) & 0xff;
  head[7] = (size >>> 24) & 0xff;
  return { bytes: concat([head, body]), format: "webp", removed: [...removed] };
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Remove location, time, device and text metadata from a JPEG, PNG or WebP.
 * Throws ImageMetadataError when such a file can't be parsed (fail closed).
 */
export function stripImageMetadata(bytes: Uint8Array): StripResult {
  const r = stripJpeg(bytes) ?? stripPng(bytes) ?? stripWebp(bytes);
  if (r) return r;
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return { bytes: copy, format: null, removed: [] };
}

/** Does the image carry a GPS position? (JPEG, PNG and WebP EXIF.) One that can't be parsed may: true. */
export function hasGps(bytes: Uint8Array): boolean {
  try {
    return stripImageMetadata(bytes).removed.includes("GPS");
  } catch {
    return true;
  }
}

const OUT_TYPE: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

/**
 * Re-encode through a canvas: only the pixels survive (orientation applied).
 * Null when this engine has no canvas or can't decode the file.
 */
export async function reencodeImage(bytes: Uint8Array, type: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string } | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    const bmp = await createImageBitmap(new Blob([copy], { type }));
    let blob: Blob | null = null;
    try {
      if (typeof OffscreenCanvas !== "undefined") {
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        c.getContext("2d")?.drawImage(bmp, 0, 0);
        blob = await c.convertToBlob({ type, quality: 0.92 });
      } else if (typeof document !== "undefined") {
        const c = document.createElement("canvas");
        c.width = bmp.width;
        c.height = bmp.height;
        c.getContext("2d")?.drawImage(bmp, 0, 0);
        blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, type, 0.92));
      }
    } finally {
      bmp.close();
    }
    if (!blob || !/^image\/(jpeg|png|webp)$/.test(blob.type)) return null;
    const out = new Uint8Array(await blob.arrayBuffer());
    // The canvas's own output is plain; checked anyway, so this never returns metadata.
    const again = stripImageMetadata(out);
    return { bytes: again.bytes, type: blob.type };
  } catch {
    return null;
  }
}

/**
 * Clean image bytes, failing closed: stripped in place when they parse,
 * re-encoded through a canvas when they don't, null when neither works (the
 * caller must then refuse the image). Formats this module doesn't clean
 * (GIF, SVG, HEIC, AVIF) come back unchanged with `format: null`.
 */
export async function cleanImageBytes(bytes: Uint8Array, type: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string; format: StripResult["format"]; removed: string[] } | null> {
  try {
    const r = stripImageMetadata(bytes);
    return { bytes: r.bytes, type: r.format ? OUT_TYPE[r.format] : type, format: r.format, removed: r.removed };
  } catch (e) {
    if (!(e instanceof ImageMetadataError)) throw e;
    const re = await reencodeImage(bytes, type);
    if (!re) return null;
    const format = /png/.test(re.type) ? "png" : /webp/.test(re.type) ? "webp" : "jpeg";
    return { bytes: re.bytes, type: re.type, format, removed: ["re-encoded"] };
  }
}

/** localStorage key: "1" keeps photos' metadata (the default removes it). */
export const KEEP_METADATA_KEY = "lumen.images.keepMetadata";

export function keepImageMetadata(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(KEEP_METADATA_KEY) === "1";
  } catch {
    return false;
  }
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/**
 * The file to store for an image added to a note: the same image without
 * its metadata (unless the user chose to keep it), same name and type. A file
 * that can't be parsed is re-encoded through a canvas (its name then takes
 * the new type's extension when the type changed); when that can't be done
 * either, this throws ImageMetadataError and the caller must not store it.
 */
export async function cleanImageFile(file: File): Promise<File> {
  if (keepImageMetadata() || !/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  const r = await cleanImageBytes(new Uint8Array(await file.arrayBuffer()), file.type);
  if (!r) throw new ImageMetadataError(file.type.slice(6), "no canvas to re-encode it");
  if (!r.format || r.removed.length === 0) return file;
  const name = r.type === file.type ? file.name : file.name.replace(/\.[^.]*$/, "") + "." + EXT[r.type];
  return new File([r.bytes], name, { type: r.type, lastModified: file.lastModified });
}
