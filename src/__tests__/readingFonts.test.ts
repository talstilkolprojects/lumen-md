/**
 * Plan W3.5 — the reading fonts: OFL, small, same-origin, downloaded only
 * when chosen, and nikud placed by the font's own mark positioning in every
 * Hebrew face (each nikud mark attaches to each letter by an anchor, so a
 * vowel never lands on top of the letter or of another mark).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ALL_READING_FONTS, DYSLEXIA_FONT, HEBREW_FONTS, __resetReadingFonts, downloadBytes, fontUrl, loadReadingFont } from "../reading/fonts";
import { cmapOf, markToBase, woff2Tables } from "./helpers/woff2";

const ROOT = resolve(__dirname, "..", "..");
const PUBLIC = join(ROOT, "public");
const read = (p: string) => new Uint8Array(readFileSync(p));

/** Every Hebrew point (U+05B0–U+05C7) a reader meets, with meteg (U+05BD) where the face has it. */
const NIKUD = [0x05b0, 0x05b1, 0x05b2, 0x05b3, 0x05b4, 0x05b5, 0x05b6, 0x05b7, 0x05b8, 0x05b9, 0x05ba, 0x05bb, 0x05bc, 0x05bf, 0x05c1, 0x05c2, 0x05c7];
// Every letter that carries points. Final mem, nun and tsadi (ם ן ץ) take none in standard
// Hebrew; Frank Ruhl Libre gives them no mark anchors (docs: reading-fonts, "Limits").
const NO_POINTS = new Set([0x05dd, 0x05df, 0x05e5]);
const LETTERS = Array.from({ length: 27 }, (_, i) => 0x05d0 + i).filter((c) => !NO_POINTS.has(c));

/** The five faces of the acceptance test, and where their Hebrew lives. */
const FACES: [string, string][] = [
  ["Noto Sans Hebrew", join(PUBLIC, "fonts/reading/noto-sans-hebrew.woff2")],
  ["Noto Serif Hebrew", join(PUBLIC, "fonts/reading/noto-serif-hebrew.woff2")],
  ["Frank Ruhl Libre", join(ROOT, "node_modules/@fontsource/frank-ruhl-libre/files/frank-ruhl-libre-hebrew-400-normal.woff2")],
  ["Assistant", join(PUBLIC, "fonts/reading/assistant.woff2")],
  ["David Libre", join(PUBLIC, "fonts/reading/david-libre-400.woff2")],
];

describe("the files", () => {
  it("every file of the catalogue is in public/, with its recorded size", () => {
    for (const f of ALL_READING_FONTS) for (const file of f.files) expect(readFileSync(join(PUBLIC, file.path)).length, file.path).toBe(file.bytes);
  });

  it("all the downloadable fonts together are at most 1.5 MB of WOFF2", () => {
    const total = ALL_READING_FONTS.reduce((n, f) => n + downloadBytes(f), 0);
    expect(total).toBeLessThanOrEqual(1.5 * 1024 * 1024);
    expect(total).toBeGreaterThan(0);
  });

  it("every one is under the SIL Open Font License 1.1, with its licence beside it", () => {
    for (const f of ALL_READING_FONTS) {
      expect(f.license).toBe("OFL-1.1");
      if (!f.files.length) continue;
      const text = readFileSync(join(PUBLIC, f.licenseFile!), "utf8");
      expect(text, f.name).toMatch(/^Copyright/);
      expect(text, f.name).toContain("SIL Open Font License, Version 1.1");
    }
  });

  it("OpenDyslexic (a Reserved Font Name) ships unmodified: the upstream files, byte for byte", () => {
    const sha = (p: string) => createHash("sha256").update(readFileSync(join(PUBLIC, p))).digest("hex");
    expect(DYSLEXIA_FONT.files.map((f) => sha(f.path).slice(0, 16))).toEqual(["0441bc21071e42db", "b534a0b84ef3cca9"]);
  });

  it("URLs are this app's own (no font service)", () => {
    for (const f of ALL_READING_FONTS) for (const file of f.files) expect(fontUrl(file)).toMatch(/^\/fonts\/reading\/[\w-]+\.woff2$/);
  });

  it("the service worker does not precache them; it caches one when it is first chosen", () => {
    const vite = readFileSync(join(ROOT, "vite.config.ts"), "utf8");
    expect(vite).toContain('"fonts/reading/**"');
    expect(vite).toMatch(/cacheName: "lumen-reading-fonts"/);
  });
});

describe("nikud in place: 5/5 Hebrew faces", () => {
  it.each(FACES)("%s: every nikud mark attaches to every letter by an anchor", (_name, path) => {
    expect(existsSync(path), path).toBe(true);
    const tables = woff2Tables(read(path));
    const cmap = cmapOf(tables.get("cmap")!);
    const { marks, bases } = markToBase(tables.get("GPOS")!);
    for (const c of LETTERS) {
      expect(cmap.has(c), `letter U+${c.toString(16)}`).toBe(true);
      expect(bases.has(cmap.get(c)!), `letter U+${c.toString(16)} is a base`).toBe(true);
    }
    for (const c of NIKUD) {
      expect(cmap.has(c), `mark U+${c.toString(16)}`).toBe(true);
      expect(marks.has(cmap.get(c)!), `mark U+${c.toString(16)} is positioned`).toBe(true);
    }
    if (cmap.has(0x05bd)) expect(marks.has(cmap.get(0x05bd)!)).toBe(true);
  });
});

describe("downloaded only when chosen", () => {
  class FakeFace {
    static made: string[] = [];
    static fail = false;
    constructor(readonly family: string, readonly src: string) {
      FakeFace.made.push(src);
    }
    load() {
      return FakeFace.fail ? Promise.reject(new Error("offline")) : Promise.resolve(this);
    }
  }
  const fonts = { added: [] as unknown[], add(f: unknown) { this.added.push(f); } };

  beforeEach(() => {
    __resetReadingFonts();
    FakeFace.made = [];
    FakeFace.fail = false;
    fonts.added = [];
    (globalThis as unknown as { FontFace: unknown }).FontFace = FakeFace;
  });

  it("a face the app already ships fetches nothing", async () => {
    expect(await loadReadingFont(HEBREW_FONTS.find((f) => f.id === "heebo")!, fonts as unknown as FontFaceSet)).toBe(true);
    expect(FakeFace.made).toEqual([]);
  });

  it("a chosen face is fetched once, from its same-origin file", async () => {
    const noto = HEBREW_FONTS.find((f) => f.id === "notoSerif")!;
    await loadReadingFont(noto, fonts as unknown as FontFaceSet);
    await loadReadingFont(noto, fonts as unknown as FontFaceSet);
    expect(FakeFace.made).toEqual(['url("/fonts/reading/noto-serif-hebrew.woff2") format("woff2")']);
    expect(fonts.added).toHaveLength(1);
  });

  it("offline: false, and a later choice tries again", async () => {
    const david = HEBREW_FONTS.find((f) => f.id === "davidLibre")!;
    FakeFace.fail = true;
    expect(await loadReadingFont(david, fonts as unknown as FontFaceSet)).toBe(false);
    FakeFace.fail = false;
    expect(await loadReadingFont(david, fonts as unknown as FontFaceSet)).toBe(true);
    expect(FakeFace.made).toHaveLength(4);
  });
});
