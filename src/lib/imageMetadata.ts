/**
 * Remove what a photo says about where and when it was taken, and on what,
 * before it goes into a note (plan W5.11, journalist mode).
 *
 * Cameras and phones write EXIF (GPS position, time, camera serial number,
 * owner name), XMP, IPTC and text chunks into JPEG, PNG and WebP files. All
 * of it is removed; the pixels are not touched (no re-encoding, no quality
 * loss). Only what a decoder needs to draw the image is kept, by an
 * allow-list (review 2, 12.11: a segment or chunk this code doesn't know,
 * such as a reserved JPEG marker or a C2PA Content Credentials chunk, goes):
 *   - JPEG: the coding segments (DQT, DHT, DAC, SOFn, SOS, DRI, DNL, RSTn),
 *     JFIF (APP0), the ICC colour profile (APP2), Adobe's colour transform
 *     (APP14), and the EXIF orientation — rewritten as an EXIF block holding
 *     that one tag, so a portrait photo still stands upright;
 *   - PNG: the critical chunks and iCCP, sRGB, gAMA, cHRM, cICP, mDCv, cLLi,
 *     pHYs, sBIT, tRNS, bKGD, acTL, fcTL, fdAT;
 *   - WebP: VP8, VP8L, VP8X, ALPH, ANIM, ANMF, ICCP (the VP8X flags are
 *     corrected).
 *
 * What a file is comes from its bytes, never from its declared type or its
 * name (review 2): a HEIC photo named .jpg is a HEIC photo. JPEG, PNG and
 * WebP are cleaned whatever they are called. HEIC, AVIF, TIFF and JPEG XL
 * can't be cleaned in place: the async helpers re-encode them through a
 * canvas (only the pixels survive) or refuse them. A file declared as JPEG,
 * PNG or WebP that is none of them throws ImageMetadataError. GIF, SVG, BMP
 * and ICO come back unchanged, with `format: null`.
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

/** What a file is, from its first bytes. */
export type MediaKind = "jpeg" | "png" | "webp" | "gif" | "svg" | "bmp" | "ico" | "heif" | "avif" | "tiff" | "jxl" | "video";

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "mif2"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

/** Sniff a file's kind from its content; null for anything that isn't an image or a video. */
export function sniffMedia(b: Uint8Array): MediaKind | null {
  const at = (o: number, sig: number[]) => b.length >= o + sig.length && sig.every((v, k) => b[o + k] === v);
  const str = (o: number, n: number) => (b.length >= o + n ? String.fromCharCode(...b.subarray(o, o + n)) : "");
  if (at(0, [0xff, 0xd8, 0xff])) return "jpeg";
  if (at(0, PNG_SIG)) return "png";
  if (str(0, 4) === "RIFF") return str(8, 4) === "WEBP" ? "webp" : str(8, 4) === "AVI " ? "video" : null;
  if (str(0, 4) === "GIF8") return "gif";
  if (at(0, [0x49, 0x49, 0x2a, 0x00]) || at(0, [0x4d, 0x4d, 0x00, 0x2a]) || at(0, [0x49, 0x49, 0x2b, 0x00]) || at(0, [0x4d, 0x4d, 0x00, 0x2b])) return "tiff";
  if (at(0, [0xff, 0x0a]) || at(0, [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20])) return "jxl";
  if (at(0, [0x1a, 0x45, 0xdf, 0xa3])) return "video"; // Matroska / WebM
  if (str(4, 4) === "ftyp") {
    // ISO-BMFF: the major brand, then the compatible ones, up to the box's size.
    const size = Math.min(b.length, ((b[0] << 24) >>> 0) + ((b[1] << 16) | (b[2] << 8) | b[3]));
    const brands = [str(8, 4)];
    for (let o = 16; o + 4 <= size; o += 4) brands.push(str(o, 4));
    if (brands.some((x) => AVIF_BRANDS.has(x))) return "avif";
    if (brands.some((x) => HEIF_BRANDS.has(x))) return "heif";
    return "video"; // mp4, mov (qt), m4v, 3gp …
  }
  if (str(4, 4) === "moov" || str(4, 4) === "mdat" || str(4, 4) === "wide") return "video"; // old QuickTime
  if (str(0, 2) === "BM") return "bmp";
  if (at(0, [0, 0, 1, 0])) return "ico";
  // SVG: text whose first element is <svg (after an XML declaration, comments or a doctype).
  const head = new TextDecoder().decode(b.subarray(0, 1024)).replace(/^\uFEFF/, "").trimStart();
  if (/^<(\?xml|!--|!doctype\s+svg|svg[\s>])/i.test(head) && /<svg[\s>]/i.test(head)) return "svg";
  return null;
}

/** Kinds that carry no location metadata we would ship: copied as they are. */
const PLAIN: ReadonlySet<MediaKind> = new Set(["gif", "svg", "bmp", "ico"]);
/** Image kinds whose metadata can't be removed in place: re-encoded through a canvas, or refused. */
const REENCODE: ReadonlySet<MediaKind> = new Set(["heif", "avif", "tiff", "jxl"]);
const MIME_OF: Partial<Record<MediaKind, string>> = { heif: "image/heic", avif: "image/avif", tiff: "image/tiff", jxl: "image/jxl" };

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

/** The coding segments a decoder needs: DQT, DHT, DAC, SOFn, SOS, DRI, DNL, DHP, EXP. */
function jpegCoding(marker: number): boolean {
  return (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc8) || marker === 0xda || marker === 0xdb || marker === 0xdd || marker === 0xdc || marker === 0xde || marker === 0xdf;
}

/** What to do with one marker segment: keep it (an allow-list), or drop it and say what it was. */
function jpegSegment(marker: number, data: Uint8Array, removed: Set<string>, found: { orientation: number | null }): boolean {
  if (jpegCoding(marker)) return true;
  if (marker === 0xe0) return true; // JFIF / JFXX
  if (marker === 0xee) return true; // Adobe: the colour transform
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
  if (marker >= 0xe3 && marker <= 0xef) {
    removed.add(marker === 0xeb ? "C2PA" : `APP${marker - 0xe0}`); // maker notes, Photoshop, FlashPix, JUMBF / C2PA …
    return false;
  }
  // Anything else (the reserved JPGn markers 0xF0–0xFD, unknown ones): not needed to draw the image.
  removed.add(`marker ${marker.toString(16).toUpperCase()}`);
  return false;
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
const PNG_DROP: Record<string, string> = { eXIf: "EXIF", tEXt: "text", zTXt: "text", iTXt: "text", tIME: "time", caBX: "C2PA" };
/** The chunks a PNG (or APNG) needs to be drawn as it was; every other chunk goes. */
const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "iCCP", "sRGB", "gAMA", "cHRM", "cICP", "mDCv", "cLLi", "pHYs", "sBIT", "tRNS", "bKGD", "acTL", "fcTL", "fdAT"]);

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
    if (!PNG_KEEP.has(type)) {
      removed.add(PNG_DROP[type] ?? type);
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

/** The chunks a WebP needs to be drawn as it was; every other chunk (C2PA among them) goes. */
const WEBP_KEEP = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF", "ICCP"]);

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
    else if (!WEBP_KEEP.has(type)) removed.add(type.trim() || "chunk");
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
 * Throws ImageMetadataError when such a file can't be parsed (fail closed),
 * when it is a HEIC, AVIF, TIFF or JPEG XL image (their metadata can't be
 * removed in place), and when `declared` names JPEG, PNG or WebP but the
 * bytes are none of them (review 2).
 */
export function stripImageMetadata(bytes: Uint8Array, declared?: string): StripResult {
  const r = stripJpeg(bytes) ?? stripPng(bytes) ?? stripWebp(bytes);
  if (r) return r;
  const kind = sniffMedia(bytes);
  if (kind && REENCODE.has(kind)) throw new ImageMetadataError(kind, "it can only be cleaned by re-encoding");
  if (declared && /^image\/(jpe?g|png|webp)$/i.test(declared) && !(kind && PLAIN.has(kind))) {
    throw new ImageMetadataError(declared.slice(6), "its bytes are not that format");
  }
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
export async function reencodeImage(bytes: Uint8Array, type: string, outType: string = type): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string } | null> {
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
        blob = await c.convertToBlob({ type: outType, quality: 0.92 });
      } else if (typeof document !== "undefined") {
        const c = document.createElement("canvas");
        c.width = bmp.width;
        c.height = bmp.height;
        c.getContext("2d")?.drawImage(bmp, 0, 0);
        blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, outType, 0.92));
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
    const r = stripImageMetadata(bytes, type);
    return { bytes: r.bytes, type: r.format ? OUT_TYPE[r.format] : type, format: r.format, removed: r.removed };
  } catch (e) {
    if (!(e instanceof ImageMetadataError)) throw e;
    // Decoded as what the bytes are (a HEIC named .jpg is decoded as HEIC); a lossless source stays lossless.
    const kind = sniffMedia(bytes);
    const source = (kind && (MIME_OF[kind] ?? OUT_TYPE[kind])) || type;
    const re = await reencodeImage(bytes, source, kind === "tiff" ? "image/png" : kind && REENCODE.has(kind) ? "image/jpeg" : type);
    if (!re) return null;
    const format = /png/.test(re.type) ? "png" : /webp/.test(re.type) ? "webp" : "jpeg";
    return { bytes: re.bytes, type: re.type, format, removed: ["re-encoded"] };
  }
}

/**
 * A file that a published site copies as it is (review 2): what to publish.
 * By content, whatever its name: a JPEG, PNG or WebP goes out cleaned (in
 * place, as the same format, so its link still matches); HEIC, AVIF, TIFF,
 * JPEG XL and video are refused (their metadata can't be removed here; the
 * caller reports them as not cleaned); anything else (GIF, SVG, a PDF, a
 * text file) is copied.
 */
export async function cleanPublishedFile(bytes: Uint8Array): Promise<{ action: "copy" } | { action: "clean"; bytes: Uint8Array<ArrayBuffer> } | { action: "refuse"; kind: MediaKind | "image" }> {
  const kind = sniffMedia(bytes);
  if (kind === "svg") {
    // An SVG can embed the original photo as a data: URL (Inkscape's "embed", diagram tools): cleaned too (review 4).
    const r = cleanDataUrls(new TextDecoder().decode(bytes));
    if (!r.cleaned && !r.withheld) return { action: "copy" };
    const out = new TextEncoder().encode(r.text);
    const copy = new Uint8Array(out.length);
    copy.set(out);
    return { action: "clean", bytes: copy };
  }
  if (kind === "ico" && containsPng(bytes)) return { action: "refuse", kind };
  if (!kind || PLAIN.has(kind)) return { action: "copy" };
  if (kind === "video" || REENCODE.has(kind)) return { action: "refuse", kind };
  const type = OUT_TYPE[kind];
  const r = await cleanImageBytes(bytes, type);
  // Re-encoded to another format, its link would not match: it stays out.
  if (!r || r.type !== type) return { action: "refuse", kind: "image" };
  return { action: "clean", bytes: r.bytes };
}

/** What a photo becomes when its metadata can't be removed: a 1×1 transparent GIF. */
export const WITHHELD_IMAGE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** Every base64 `data:` URL, whatever its label (review 4, RR4-473-2): the label says nothing about the bytes. */
const DATA_URL = /data:([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+)?((?:;[a-z0-9!#$&^_.+-]+=[^;,\s"')]*)*);base64,([A-Za-z0-9+/]+={0,2})/gi;
/** SVG inside SVG inside SVG: deeper than this is withheld rather than read. */
const MAX_SVG_DEPTH = 3;

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const containsPng = (b: Uint8Array) => {
  for (let i = b.indexOf(0x89); i >= 0 && i + 8 <= b.length; i = b.indexOf(0x89, i + 1)) if (PNG_SIG.every((v, k) => b[i + k] === v)) return true;
  return false;
};

/** A data: URL's fate: the same URL, a cleaned one, null (withhold it), or bytes only a canvas could clean. */
type DataUrlVerdict = { url: string; changed: boolean } | null;
type Judged = DataUrlVerdict | { reencode: Uint8Array; kind: MediaKind };

/**
 * One data: URL, judged by its bytes. JPEG, PNG and WebP are stripped in
 * place; an SVG has its own embedded data: URLs cleaned; GIF and BMP carry no
 * location and stay; an ICO with PNG frames, video, and anything labelled
 * image/* that is no image we know are withheld; HEIC, AVIF, TIFF, JPEG XL
 * and a JPEG/PNG/WebP that doesn't parse need a canvas (the async doors) or
 * are withheld. Bytes that are no image under a label that is not image/*
 * (a PDF, a text) stay.
 */
function judgeDataUrl(whole: string, label: string, b64: string, depth: number): Judged {
  const imageLabel = /^image\//i.test(label);
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(b64);
  } catch {
    return imageLabel ? null : { url: whole, changed: false };
  }
  const kind = sniffMedia(bytes);
  if (!kind) return imageLabel ? null : { url: whole, changed: false };
  if (kind === "jpeg" || kind === "png" || kind === "webp") {
    try {
      const r = stripImageMetadata(bytes);
      const type = OUT_TYPE[kind];
      if (!r.removed.length && label.toLowerCase() === type) return { url: whole, changed: false };
      return { url: `data:${type};base64,${toBase64(r.bytes)}`, changed: true };
    } catch {
      return { reencode: bytes, kind };
    }
  }
  if (kind === "svg") {
    if (depth >= MAX_SVG_DEPTH) return null;
    const inner = cleanDataUrlsAt(new TextDecoder().decode(bytes), depth + 1);
    if (!inner.cleaned && !inner.withheld) return { url: whole, changed: false };
    return { url: `data:image/svg+xml;base64,${toBase64(new TextEncoder().encode(inner.text))}`, changed: true };
  }
  if (kind === "gif" || kind === "bmp") return { url: whole, changed: false };
  if (kind === "ico") return containsPng(bytes) ? null : { url: whole, changed: false };
  if (kind === "video") return null;
  return { reencode: bytes, kind };
}

function replaceDataUrls(text: string, verdicts: Map<string, DataUrlVerdict>): { text: string; cleaned: number; withheld: number } {
  let cleaned = 0;
  let withheld = 0;
  const out = text.replace(DATA_URL, (whole) => {
    const v = verdicts.get(whole);
    if (!v) {
      withheld++;
      return WITHHELD_IMAGE;
    }
    if (v.changed) cleaned++;
    return v.url;
  });
  return { text: out, cleaned, withheld };
}

function cleanDataUrlsAt(text: string, depth: number): { text: string; cleaned: number; withheld: number } {
  const verdicts = new Map<string, DataUrlVerdict>();
  for (const m of text.matchAll(DATA_URL)) {
    if (verdicts.has(m[0])) continue;
    const j = judgeDataUrl(m[0], m[1] ?? "", m[3], depth);
    verdicts.set(m[0], j && "reencode" in j ? null : j);
  }
  return verdicts.size ? replaceDataUrls(text, verdicts) : { text, cleaned: 0, withheld: 0 };
}

/**
 * Every base64 data: URL in `text` (a note, an SVG's source), judged by its
 * bytes whatever its label (`judgeDataUrl`), without a canvas: what can't be
 * stripped in place is withheld (WITHHELD_IMAGE).
 */
export function cleanDataUrls(text: string): { text: string; cleaned: number; withheld: number } {
  return cleanDataUrlsAt(text, 0);
}

/** The same, re-encoding through a canvas what can't be stripped in place; withheld only when that fails too. */
export async function cleanDataUrlsAsync(text: string): Promise<{ text: string; cleaned: number; withheld: number }> {
  const verdicts = new Map<string, DataUrlVerdict>();
  for (const m of text.matchAll(DATA_URL)) {
    if (verdicts.has(m[0])) continue;
    const j = judgeDataUrl(m[0], m[1] ?? "", m[3], 0);
    if (j && "reencode" in j) {
      const r = await cleanImageBytes(j.reencode, MIME_OF[j.kind] ?? OUT_TYPE[j.kind] ?? "application/octet-stream");
      verdicts.set(m[0], r ? { url: `data:${r.type};base64,${toBase64(r.bytes)}`, changed: true } : null);
    } else verdicts.set(m[0], j);
  }
  return verdicts.size ? replaceDataUrls(text, verdicts) : { text, cleaned: 0, withheld: 0 };
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
  if (keepImageMetadata()) return file;
  const bytes = new Uint8Array(await file.arrayBuffer());
  // By content, not by the declared type (review 2): a HEIC photo saved as .jpg is still a HEIC photo.
  const kind = sniffMedia(bytes);
  const declaredPhoto = /^image\/(jpeg|png|webp)$/.test(file.type);
  if (!declaredPhoto && !(kind && (kind in OUT_TYPE || REENCODE.has(kind)))) return file;
  const r = await cleanImageBytes(bytes, declaredPhoto ? file.type : (kind && OUT_TYPE[kind]) || file.type);
  if (!r) throw new ImageMetadataError((kind ?? file.type.slice(6)) || "image", "no canvas to re-encode it");
  if (!r.format || r.removed.length === 0) return file;
  const name = r.type === file.type ? file.name : file.name.replace(/\.[^.]*$/, "") + "." + EXT[r.type];
  return new File([r.bytes], name, { type: r.type, lastModified: file.lastModified });
}
