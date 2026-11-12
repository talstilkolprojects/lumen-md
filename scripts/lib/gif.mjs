/**
 * Animated GIFs from Playwright screenshots, with no dependencies (plan
 * W4.34): the docs' GIFs are recorded in any environment that runs
 * Playwright — no ffmpeg, no ImageMagick.
 *
 *   decodePng(buffer)                 → { width, height, rgba }
 *   encodeGif(frames, { loop })       → Buffer (GIF89a)
 *     frames: [{ rgba, width, height, delayMs }]
 *
 * One global palette for the whole animation (the 256 most frequent colours
 * at 5 bits per channel — UI screenshots have few colours), each pixel
 * mapped to its nearest palette colour. After the first frame only the
 * rectangle that changed is stored, so a GIF of a dialog opening costs
 * about one screenshot plus the dialog.
 */
import { inflateSync } from "node:zlib";

/** Decode an 8-bit, non-interlaced RGB or RGBA PNG (what Playwright's screenshots are). */
export function decodePng(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error("not a PNG");
  let pos = 8;
  let width = 0, height = 0, colorType = 0, bitDepth = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) throw new Error(`unsupported PNG (bit depth ${bitDepth}, colour type ${colorType}, interlace ${interlace})`);
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = cur[x * bpp];
      out[o + 1] = cur[x * bpp + 1];
      out[o + 2] = cur[x * bpp + 2];
      out[o + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, rgba: out };
}

const key15 = (r, g, b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

/** The 256 most frequent colours of the frames (5 bits per channel), as [r, g, b] at the bucket's mean. */
export function buildPalette(frames) {
  const count = new Map();
  const sum = new Map();
  for (const f of frames) {
    const p = f.rgba;
    for (let i = 0; i < p.length; i += 4) {
      const k = key15(p[i], p[i + 1], p[i + 2]);
      count.set(k, (count.get(k) ?? 0) + 1);
      let s = sum.get(k);
      if (!s) sum.set(k, (s = [0, 0, 0]));
      s[0] += p[i];
      s[1] += p[i + 1];
      s[2] += p[i + 2];
    }
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 256)
    .map(([k, n]) => sum.get(k).map((v) => Math.round(v / n)));
}

function nearestIndexer(palette) {
  const cache = new Map();
  return (r, g, b) => {
    const k = key15(r, g, b);
    let i = cache.get(k);
    if (i !== undefined) return i;
    let best = 0;
    let bestD = Infinity;
    for (let j = 0; j < palette.length; j++) {
      const [pr, pg, pb] = palette[j];
      const d = (pr - r) * (pr - r) * 2 + (pg - g) * (pg - g) * 4 + (pb - b) * (pb - b) * 3;
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    cache.set(k, best);
    return best;
  };
}

/** GIF LZW: the image data sub-blocks for `indices` at code size `minCode`. */
export function lzw(indices, minCode = 8) {
  const clear = 1 << minCode;
  const eoi = clear + 1;
  const out = [];
  let cur = 0;
  let nbits = 0;
  let size = minCode + 1;
  const emit = (code) => {
    cur |= code << nbits;
    nbits += size;
    while (nbits >= 8) {
      out.push(cur & 255);
      cur >>>= 8;
      nbits -= 8;
    }
  };
  let dict = new Map();
  let next = eoi + 1;
  emit(clear);
  let prefix = indices.length ? indices[0] : -1;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 256 + k;
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > 1 << size && size < 12) size++;
    } else {
      emit(clear);
      dict = new Map();
      next = eoi + 1;
      size = minCode + 1;
    }
    prefix = k;
  }
  if (prefix >= 0) emit(prefix);
  emit(eoi);
  if (nbits > 0) out.push(cur & 255);
  // Sub-blocks of at most 255 bytes, then a zero-length terminator.
  const blocks = [];
  for (let i = 0; i < out.length; i += 255) {
    const part = out.slice(i, i + 255);
    blocks.push(part.length, ...part);
  }
  blocks.push(0);
  return Buffer.from(blocks);
}

/** The rectangle where `a` and `b` (palette indices) differ, or null when equal. */
function changedRect(a, b, width, height) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (a[row + x] !== b[row + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Encode frames (all the same size) as an animated GIF89a; `loop` 0 = forever. */
export function encodeGif(frames, { loop = 0 } = {}) {
  if (!frames.length) throw new Error("no frames");
  const { width, height } = frames[0];
  for (const f of frames) if (f.width !== width || f.height !== height) throw new Error("all frames must be the same size");
  const palette = buildPalette(frames);
  while (palette.length < 256) palette.push([0, 0, 0]);
  const index = nearestIndexer(palette);
  const parts = [];
  const u16 = (n) => [n & 255, (n >> 8) & 255];
  // Header, logical screen (global colour table of 256), the palette, looping.
  parts.push(Buffer.from("GIF89a", "latin1"), Buffer.from([...u16(width), ...u16(height), 0xf7, 0, 0]), Buffer.from(palette.flat()));
  parts.push(Buffer.from([0x21, 0xff, 11, ...Buffer.from("NETSCAPE2.0", "latin1"), 3, 1, ...u16(loop), 0]));
  let prev = null;
  let pendingDelay = 0;
  frames.forEach((f) => {
    const idx = new Uint8Array(width * height);
    for (let p = 0, o = 0; p < idx.length; p++, o += 4) idx[p] = index(f.rgba[o], f.rgba[o + 1], f.rgba[o + 2]);
    let rect = prev ? changedRect(prev, idx, width, height) : { x: 0, y: 0, w: width, h: height };
    if (!rect) {
      // Nothing changed: hold the previous frame longer instead of adding one.
      pendingDelay += f.delayMs ?? 100;
      return;
    }
    if (pendingDelay && parts.length) {
      const gce = parts[parts.length - 3];
      const cs = Math.min(65535, gce.readUInt16LE(4) + Math.round(pendingDelay / 10));
      gce.writeUInt16LE(cs, 4);
      pendingDelay = 0;
    }
    const sub = new Uint8Array(rect.w * rect.h);
    for (let y = 0; y < rect.h; y++) sub.set(idx.subarray((rect.y + y) * width + rect.x, (rect.y + y) * width + rect.x + rect.w), y * rect.w);
    const delay = Math.max(2, Math.round((f.delayMs ?? 100) / 10));
    // Graphic control: disposal 1 (keep), delay in 1/100 s; image descriptor; LZW data.
    parts.push(Buffer.from([0x21, 0xf9, 4, 0x04, ...u16(delay), 0, 0]));
    parts.push(Buffer.from([0x2c, ...u16(rect.x), ...u16(rect.y), ...u16(rect.w), ...u16(rect.h), 0, 8]));
    parts.push(lzw(sub, 8));
    prev = idx;
  });
  if (pendingDelay && parts.length > 4) {
    const gce = parts[parts.length - 3];
    gce.writeUInt16LE(Math.min(65535, gce.readUInt16LE(4) + Math.round(pendingDelay / 10)), 4);
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}
