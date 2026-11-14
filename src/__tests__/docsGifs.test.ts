/**
 * The docs GIFs (plan W4.34): 30 recorded flows, each for a docs page that
 * exists in English and Hebrew and driven by palette commands that exist;
 * the dependency-free PNG decoder and GIF encoder the recorder uses give
 * back the pixels they were given (decoded here with a GIF decoder written
 * from the format, not the encoder's own code).
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { decodePng, encodeGif, lzw } from "../../scripts/lib/gif.mjs";

const ROOT = resolve(__dirname, "../..");
const flows = readFileSync(join(ROOT, "e2e/gifs/flows.ts"), "utf8");
const DOCS = join(ROOT, "docs/src/content/docs");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "__tests__") return [];
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

describe("docs GIF flows", () => {
  const ids = [...flows.matchAll(/^\s+id: "([^"]+)"|^\s+(?:opens|inserts)\("([^"]+)"/gm)].map((m) => m[1] ?? m[2]);

  it("there are 30, with unique ids that make safe file names", () => {
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it("each one's docs page exists in English and in Hebrew", () => {
    const pages = [...flows.matchAll(/page: "([^"]+)"|(?:opens|inserts)\("[^"]+", "[^"]+", "[^"]+", "([^"]+)"/g)].map((m) => m[1] ?? m[2]);
    expect(pages).toHaveLength(30);
    const has = (p: string) => existsSync(join(DOCS, `${p}.md`)) || existsSync(join(DOCS, `${p}.mdx`));
    for (const p of pages) {
      expect(has(p), p).toBe(true);
      expect(has(`he/${p}`), `he/${p}`).toBe(true);
    }
  });

  it("every palette command a flow runs exists in the app", () => {
    const used = new Set([...flows.matchAll(/(?:command|run)\("([a-z][\w.]*\.[\w.]+)"\)|(?:opens|inserts)\((?:"[^"]*", ){4}"([^"]+)"/g)].map((m) => m[1] ?? m[2]));
    for (const m of flows.matchAll(/for \(const m of \[([^\]]+)\]\)/g)) for (const id of m[1].matchAll(/"([^"]+)"/g)) used.add(id[1]);
    const app = sources(join(ROOT, "src")).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(used.size).toBeGreaterThan(20);
    for (const id of used) expect(app.includes(`id: "${id}"`), id).toBe(true);
  });

  it("the recorder is not part of the e2e suite (its file is *.gifs.ts)", () => {
    expect(readdirSync(join(ROOT, "e2e/gifs")).sort()).toEqual(["flows.ts", "record.gifs.ts"]);
  });
});

/** A PNG with filter `f` on every row (RGBA or RGB). */
function png(width: number, height: number, rgba: Uint8Array, rgb = false, f = 0): Buffer {
  const bpp = rgb ? 3 : 4;
  const raw = Buffer.alloc(height * (width * bpp + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * bpp + 1)] = f;
    for (let x = 0; x < width; x++)
      for (let c = 0; c < bpp; c++) {
        const v = rgba[(y * width + x) * 4 + c];
        const left = x ? rgba[(y * width + x - 1) * 4 + c] : 0;
        const up = y ? rgba[((y - 1) * width + x) * 4 + c] : 0;
        raw[y * (width * bpp + 1) + 1 + x * bpp + c] = f === 1 ? (v - left) & 255 : f === 2 ? (v - up) & 255 : v;
      }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = rgb ? 2 : 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Decode a GIF (global palette, LZW) into full RGBA frames with their delays — from the format. */
function decodeGif(buf: Buffer): { width: number; height: number; frames: { rgba: Uint8Array; delay: number }[] } {
  expect(buf.toString("latin1", 0, 6)).toBe("GIF89a");
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const flags = buf[10];
  const size = 2 << (flags & 7);
  const pal = buf.subarray(13, 13 + size * 3);
  let pos = 13 + (flags & 0x80 ? size * 3 : 0);
  const canvas = new Uint8Array(width * height * 4);
  const frames: { rgba: Uint8Array; delay: number }[] = [];
  let delay = 0;
  while (buf[pos] !== 0x3b) {
    if (buf[pos] === 0x21) {
      if (buf[pos + 1] === 0xf9) delay = buf.readUInt16LE(pos + 4);
      pos += 2;
      while (buf[pos]) pos += buf[pos] + 1;
      pos++;
      continue;
    }
    expect(buf[pos]).toBe(0x2c);
    const [x, y, w, h] = [buf.readUInt16LE(pos + 1), buf.readUInt16LE(pos + 3), buf.readUInt16LE(pos + 5), buf.readUInt16LE(pos + 7)];
    const min = buf[pos + 10];
    pos += 11;
    const data: number[] = [];
    while (buf[pos]) {
      data.push(...buf.subarray(pos + 1, pos + 1 + buf[pos]));
      pos += buf[pos] + 1;
    }
    pos++;
    // LZW decode.
    const clear = 1 << min;
    let codeSize = min + 1;
    let dict: number[][] = [];
    const reset = () => {
      dict = Array.from({ length: clear + 2 }, (_, i) => [i]);
      codeSize = min + 1;
    };
    reset();
    const out: number[] = [];
    let bit = 0;
    let prev: number[] | null = null;
    for (;;) {
      let code = 0;
      for (let i = 0; i < codeSize; i++, bit++) code |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
      if (code === clear) {
        reset();
        prev = null;
        continue;
      }
      if (code === clear + 1) break;
      const entry: number[] = code < dict.length ? dict[code] : [...prev!, prev![0]];
      out.push(...entry);
      if (prev) dict.push([...prev, entry[0]]);
      prev = entry;
      if (dict.length === 1 << codeSize && codeSize < 12) codeSize++;
    }
    expect(out).toHaveLength(w * h);
    out.forEach((ix, i) => {
      const o = ((y + Math.floor(i / w)) * width + x + (i % w)) * 4;
      canvas.set([pal[ix * 3], pal[ix * 3 + 1], pal[ix * 3 + 2], 255], o);
    });
    frames.push({ rgba: canvas.slice(), delay });
  }
  return { width, height, frames };
}

describe("GIF encoder", () => {
  const W = 40;
  const H = 24;
  const image = (seed: number) => {
    const p = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const c = (Math.floor(i / 7) + seed) % 6;
      p.set([c * 40, 255 - c * 40, (c * 97) % 256, 255], i * 4);
    }
    return p;
  };

  it("decodes PNGs with each row filter, RGBA and RGB", () => {
    const a = image(1);
    for (const f of [0, 1, 2]) for (const rgb of [false, true]) expect(decodePng(png(W, H, a, rgb, f))).toEqual({ width: W, height: H, rgba: a });
  });

  it("round-trips frames exactly (≤ 256 colours), stores only what changed, merges a repeated frame into the delay", () => {
    const a = image(0);
    const b = a.slice();
    b.set([0, 0, 0, 255], (5 * W + 7) * 4); // one pixel changes
    const gif = encodeGif([
      { width: W, height: H, rgba: a, delayMs: 500 },
      { width: W, height: H, rgba: b, delayMs: 300 },
      { width: W, height: H, rgba: b, delayMs: 700 },
    ]);
    const d = decodeGif(gif);
    expect(d.frames.map((f) => f.delay)).toEqual([50, 100]);
    expect(d.frames[0].rgba).toEqual(a);
    expect(d.frames[1].rgba).toEqual(b);
    // The second frame is the one changed pixel.
    expect(gif.includes(Buffer.from([0x2c, 7, 0, 5, 0, 1, 0, 1, 0, 0, 8]))).toBe(true);
    expect(gif.includes(Buffer.from("NETSCAPE2.0", "latin1"))).toBe(true);
  });

  it("LZW survives a full dictionary (more than 4096 codes) and long runs", () => {
    const n = 60_000;
    const idx = new Uint8Array(n);
    let s = 7;
    for (let i = 0; i < n; i++) idx[i] = (s = (s * 1103515245 + 12345) & 0x7fffffff) % 256;
    const rgba = new Uint8Array(n * 4);
    // A 300×200 image of 256 grey levels in a pseudo-random order, then a solid band.
    for (let i = 0; i < n; i++) rgba.set(i < 50_000 ? [idx[i], idx[i], idx[i], 255] : [9, 9, 9, 255], i * 4);
    const d = decodeGif(encodeGif([{ width: 300, height: 200, rgba }]));
    let wrong = 0;
    for (let i = 0; i < n; i++) if (Math.abs(d.frames[0].rgba[i * 4] - rgba[i * 4]) > 8) wrong++;
    expect(wrong).toBe(0);
    expect(lzw([1, 1, 1, 1], 8).at(-1)).toBe(0);
  });
});
