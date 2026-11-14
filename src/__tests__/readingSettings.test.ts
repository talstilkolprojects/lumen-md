/**
 * Plan W3.5 — reading options: global or per note, valid values only, and
 * the CSS the preview reads.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { DEFAULT_READING, effectiveReading, globalReading, moveNoteReading, noteReading, normalize, readingVars, saveGlobalReading, saveNoteReading, applyReading, type ReadingSettings } from "../reading/settings";
import { __resetReadingFonts } from "../reading/fonts";

beforeEach(() => {
  localStorage.clear();
  __resetReadingFonts();
});

const with_ = (p: Partial<ReadingSettings>): ReadingSettings => ({ ...DEFAULT_READING, ...p });

describe("values", () => {
  it("clamps numbers and drops an unknown face", () => {
    expect(normalize({ size: 99, lineHeight: 0.5, width: 10, font: "comic" as never })).toEqual({ ...DEFAULT_READING, size: 28, lineHeight: 1.3, width: 40 });
    expect(normalize({ size: Number.NaN })).toEqual(DEFAULT_READING);
  });

  it("survives broken storage", () => {
    localStorage.setItem("lumen-reading", "{not json");
    expect(globalReading()).toEqual(DEFAULT_READING);
  });
});

describe("global or per note", () => {
  it("a note follows the global settings until it has its own", () => {
    saveGlobalReading(with_({ font: "notoSerif", size: 20 }));
    expect(effectiveReading("a.md")).toMatchObject({ font: "notoSerif", size: 20 });
    expect(noteReading("a.md")).toBeNull();
    saveNoteReading("a.md", with_({ font: "davidLibre", width: 60 }));
    expect(effectiveReading("a.md")).toMatchObject({ font: "davidLibre", width: 60 });
    expect(effectiveReading("b.md")).toMatchObject({ font: "notoSerif", size: 20 });
    expect(effectiveReading(null)).toMatchObject({ font: "notoSerif" });
  });

  it("dropping a note's own settings returns it to the global ones; a rename keeps them", () => {
    saveNoteReading("a.md", with_({ size: 22 }));
    moveNoteReading("a.md", "dir/a.md");
    expect(noteReading("a.md")).toBeNull();
    expect(noteReading("dir/a.md")).toMatchObject({ size: 22 });
    saveNoteReading("dir/a.md", null);
    expect(noteReading("dir/a.md")).toBeNull();
  });

  it("moving a folder carries the settings of every note in it", () => {
    saveNoteReading("old/x.md", with_({ width: 50 }));
    saveNoteReading("old/sub/y.md", with_({ width: 52 }));
    saveNoteReading("older.md", with_({ width: 54 }));
    moveNoteReading("old", "new");
    expect(noteReading("new/x.md")).toMatchObject({ width: 50 });
    expect(noteReading("new/sub/y.md")).toMatchObject({ width: 52 });
    expect(noteReading("older.md")).toMatchObject({ width: 54 });
  });

  it("each change tells the app (it re-applies the open note's settings)", () => {
    let n = 0;
    const on = () => n++;
    window.addEventListener("lumen-reading-changed", on);
    saveGlobalReading(DEFAULT_READING);
    saveNoteReading("x.md", DEFAULT_READING);
    window.removeEventListener("lumen-reading-changed", on);
    expect(n).toBe(2);
  });
});

describe("the CSS", () => {
  it("the defaults leave the stylesheet alone", () => {
    expect(Object.values(readingVars(DEFAULT_READING)).every((v) => v === null)).toBe(true);
  });

  it("a face, size, line height and width", () => {
    const v = readingVars(with_({ font: "notoSerif", size: 20, lineHeight: 2, width: 60 }));
    expect(v["--reading-font"]).toBe('"Lumen Noto Serif Hebrew", var(--font-serif)');
    expect(v["--reading-size"]).toBe("20px");
    expect(v["--reading-line-height"]).toBe("2");
    expect(v["--reading-width"]).toBe("60ch");
    expect(readingVars(with_({ font: "assistant" }))["--reading-font"]).toBe('"Lumen Assistant", var(--font-sans)');
  });

  it("dyslexia-friendly Latin comes first; Hebrew falls through to its own face", () => {
    expect(readingVars(with_({ font: "frankRuhl", dyslexiaLatin: true }))["--reading-font"]).toBe('"Lumen OpenDyslexic", "Frank Ruhl Libre", var(--font-serif)');
  });

  it("spaced Hebrew: wider words and letters, and room for nikud between lines", () => {
    const v = readingVars(with_({ spacedHebrew: true, lineHeight: 1.5 }));
    expect(v["--reading-word-spacing"]).toBe("0.18em");
    expect(v["--reading-letter-spacing"]).toBe("0.02em");
    expect(v["--reading-line-height"]).toBe("1.9");
  });

  it("applyReading writes and clears the properties", async () => {
    const el = document.createElement("div");
    (globalThis as unknown as { FontFace: unknown }).FontFace = class {
      load() {
        return Promise.resolve(this);
      }
    };
    expect(await applyReading(with_({ size: 21 }), el)).toBe(true);
    expect(el.style.getPropertyValue("--reading-size")).toBe("21px");
    await applyReading(DEFAULT_READING, el);
    expect(el.style.getPropertyValue("--reading-size")).toBe("");
  });
});
