/**
 * Just enough of WOFF2 and OpenType to check a reading font in a test:
 * the table directory, the Brotli stream (Node's zlib), `cmap` (code point
 * → glyph) and `GPOS` mark-to-base coverage. Transformed tables (glyf,
 * loca) are skipped; nothing here needs them.
 */
import { brotliDecompressSync } from "node:zlib";

const TAGS =
  "cmap head hhea hmtx maxp name OS/2 post cvt  fpgm glyf loca prep CFF  VORG EBDT EBLC gasp hdmx kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG  sbix acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak Zapf Silf Glat Gloc Feat Sill"
    .match(/.{4}\s?/g)!
    .map((s) => s.slice(0, 4));

function base128(b: Uint8Array, at: { i: number }): number {
  let v = 0;
  for (let n = 0; n < 5; n++) {
    const x = b[at.i++];
    v = v * 128 + (x & 0x7f);
    if (!(x & 0x80)) return v;
  }
  throw new Error("bad UIntBase128");
}

/** Untransformed tables of a WOFF2 file, by tag. */
export function woff2Tables(file: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (dv.getUint32(0) !== 0x774f4632) throw new Error("not WOFF2");
  const numTables = dv.getUint16(12);
  const compressed = dv.getUint32(20);
  const at = { i: 48 };
  const dir: { tag: string; length: number; transformed: boolean }[] = [];
  for (let n = 0; n < numTables; n++) {
    const flags = file[at.i++];
    let tag = TAGS[flags & 0x3f];
    if ((flags & 0x3f) === 63) {
      tag = String.fromCharCode(...file.subarray(at.i, at.i + 4));
      at.i += 4;
    }
    const version = flags >> 6;
    const orig = base128(file, at);
    const glyfLoca = tag === "glyf" || tag === "loca";
    const transformed = glyfLoca ? version === 0 : version !== 0;
    const length = transformed ? base128(file, at) : orig;
    dir.push({ tag, length, transformed });
  }
  const data = brotliDecompressSync(file.subarray(at.i, at.i + compressed));
  const out = new Map<string, Uint8Array>();
  let off = 0;
  for (const d of dir) {
    if (!d.transformed) out.set(d.tag, new Uint8Array(data.buffer, data.byteOffset + off, d.length));
    off += d.length;
  }
  return out;
}

/** Code point → glyph id, from a format 4 or 12 `cmap` subtable. */
export function cmapOf(cmap: Uint8Array): Map<number, number> {
  const dv = new DataView(cmap.buffer, cmap.byteOffset, cmap.byteLength);
  const n = dv.getUint16(2);
  const map = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const off = dv.getUint32(4 + i * 8 + 4);
    const format = dv.getUint16(off);
    if (format === 12) {
      const groups = dv.getUint32(off + 12);
      for (let g = 0; g < groups; g++) {
        const p = off + 16 + g * 12;
        const start = dv.getUint32(p);
        const end = dv.getUint32(p + 4);
        const gid = dv.getUint32(p + 8);
        for (let c = start; c <= end; c++) map.set(c, gid + c - start);
      }
      return map;
    }
  }
  for (let i = 0; i < n; i++) {
    const off = dv.getUint32(4 + i * 8 + 4);
    if (dv.getUint16(off) !== 4) continue;
    const segX2 = dv.getUint16(off + 6);
    const ends = off + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    for (let s = 0; s < segX2 / 2; s++) {
      const end = dv.getUint16(ends + s * 2);
      const start = dv.getUint16(starts + s * 2);
      const delta = dv.getInt16(deltas + s * 2);
      const ro = dv.getUint16(ranges + s * 2);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let gid: number;
        if (ro === 0) gid = (c + delta) & 0xffff;
        else {
          const g = dv.getUint16(ranges + s * 2 + ro + (c - start) * 2);
          gid = g === 0 ? 0 : (g + delta) & 0xffff;
        }
        if (gid) map.set(c, gid);
      }
    }
    return map;
  }
  return map;
}

function coverage(dv: DataView, off: number): Set<number> {
  const out = new Set<number>();
  const format = dv.getUint16(off);
  const count = dv.getUint16(off + 2);
  if (format === 1) for (let i = 0; i < count; i++) out.add(dv.getUint16(off + 4 + i * 2));
  else
    for (let i = 0; i < count; i++) {
      const p = off + 4 + i * 6;
      for (let g = dv.getUint16(p); g <= dv.getUint16(p + 2); g++) out.add(g);
    }
  return out;
}

/** Glyphs that mark-to-base positioning (GPOS lookup type 4) attaches: the marks and the bases. */
export function markToBase(gpos: Uint8Array): { marks: Set<number>; bases: Set<number> } {
  const dv = new DataView(gpos.buffer, gpos.byteOffset, gpos.byteLength);
  const lookupList = dv.getUint16(8);
  const lookups = dv.getUint16(lookupList);
  const marks = new Set<number>();
  const bases = new Set<number>();
  for (let l = 0; l < lookups; l++) {
    const lo = lookupList + dv.getUint16(lookupList + 2 + l * 2);
    const type = dv.getUint16(lo);
    const subs = dv.getUint16(lo + 4);
    for (let s = 0; s < subs; s++) {
      let so = lo + dv.getUint16(lo + 6 + s * 2);
      let t = type;
      if (t === 9) {
        t = dv.getUint16(so + 2);
        so += dv.getUint32(so + 4);
      }
      if (t !== 4) continue;
      for (const g of coverage(dv, so + dv.getUint16(so + 2))) marks.add(g);
      for (const g of coverage(dv, so + dv.getUint16(so + 4))) bases.add(g);
    }
  }
  return { marks, bases };
}
