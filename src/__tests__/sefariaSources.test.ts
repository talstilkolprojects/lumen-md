/**
 * Plan W5.1: Jewish sources from Sefaria — references in 50 formats,
 * licences per version (only free text is ever copied), the offline copy
 * (a second lookup makes no request), niqqud and cantillation kept, and the
 * notes that cite a verse.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hebrewNumeral, parseNumber, parseSourceRef, sourceRefsIn } from "../sources/sefaria/refs";
import { isFreeLicense, licenseUrl } from "../sources/sefaria/license";
import { apiUrl, parseTextsResponse } from "../sources/sefaria/client";
import { lookupPassage, notesCiting, parseSourceNote, quoteBlock, renderSourceNote, savePassage, sourceNotePath, type SourceStorage } from "../sources/sefaria/store";

const FORMATS: Array<{ input: string; tref: string }> = JSON.parse(readFileSync(join(__dirname, "fixtures", "sefaria", "refs.json"), "utf8")).items;

// Genesis 1:1 with points and cantillation, as Sefaria's Masoretic text carries it.
const HE = "בְּרֵאשִׁ֖ית בָּרָ֣א אֱלֹהִ֑ים אֵ֥ת הַשָּׁמַ֖יִם וְאֵ֥ת הָאָֽרֶץ׃";
const EN_NC = "When God began to create heaven and earth";

/** A v3 texts response in the shape of Sefaria's OpenAPI spec (v3TextsJson / v3TextVersionsJSON). */
const RESPONSE = {
  ref: "Genesis 1:1",
  heRef: "בראשית א׳:א׳",
  versions: [
    { text: HE, language: "he", actualLanguage: "he", direction: "rtl", versionTitle: "Miqra according to the Masorah", versionSource: "https://he.wikisource.org/wiki/User:Dovi/Miqra_according_to_the_Masorah", license: "CC-BY-SA", isSource: true },
    { text: EN_NC, language: "en", actualLanguage: "en", direction: "ltr", versionTitle: "The Contemporary Torah, Jewish Publication Society, 2006", versionSource: "https://jps.org", license: "CC-BY-NC", isSource: false },
  ],
};

function memoryStorage(): SourceStorage & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return { files, read: async (p) => files.get(p) ?? null, write: async (p, c) => void files.set(p, c) };
}

describe("references", () => {
  it("parses 50 formats: at least 48 right", () => {
    expect(FORMATS.length).toBe(50);
    const wrong = FORMATS.filter((f) => parseSourceRef(f.input)?.tref !== f.tref).map((f) => `${f.input} → ${parseSourceRef(f.input)?.tref ?? "null"}`);
    expect(wrong.length, wrong.join("; ")).toBeLessThanOrEqual(2);
  });

  it("gives the Hebrew form, the Sefaria link and a verse key", () => {
    const r = parseSourceRef("שמות כ׳ ג׳")!;
    expect(r.he).toBe("שמות כ׳:ג׳");
    expect(r.url).toBe("https://www.sefaria.org/Exodus.20.3");
    expect(r.key).toBe("Exodus.20.3");
    expect(parseSourceRef("ברכות ב:")!.he).toBe("ברכות ב׳ ע״ב");
    expect(parseSourceRef("I Samuel 3:4")!.url).toBe("https://www.sefaria.org/I_Samuel.3.4");
  });

  it("reads Hebrew numerals the way they are written, and only those", () => {
    expect([parseNumber("א"), parseNumber("ט״ו"), parseNumber("טז"), parseNumber("קי\"ט"), parseNumber("12")]).toEqual([1, 15, 16, 119, 12]);
    expect(parseNumber("ברא")).toBe(null); // a word, not 203
    expect([15, 16, 119, 1, 20].map(hebrewNumeral)).toEqual(["ט״ו", "ט״ז", "קי״ט", "א׳", "כ׳"]);
  });

  it("is not fooled by ordinary text", () => {
    for (const s of ["שלום עולם", "בראשית ברא אלוהים", "בראשית", "hello 1:1", "Genesis", "ברכות", "שמות הילדים", "[[Some note]]"]) expect({ s, r: parseSourceRef(s) }).toEqual({ s, r: null });
  });

  it("finds references in a note: wiki links and Sefaria links", () => {
    const md = "ראו [[בראשית א:א]] וגם [[Genesis.1.1|הפסוק]] ו-https://www.sefaria.org/Berakhot.2a ו-[[פתק רגיל]].";
    expect(sourceRefsIn(md).map((r) => r.key)).toEqual(["Genesis.1.1", "Genesis.1.1", "Berakhot.2a"]);
  });
});

describe("licences", () => {
  it("copies only free licences; non-commercial, copyrighted and unknown are link-only", () => {
    expect(["Public Domain", "PD", "CC0", "CC-BY", "CC-BY-SA"].map(isFreeLicense)).toEqual([true, true, true, true, true]);
    expect(["CC-BY-NC", "CC-BY-NC-SA", "CC-BY-NC-ND", "Copyright: JPS, 1985", "", undefined].map(isFreeLicense)).toEqual([false, false, false, false, false, false]);
    expect(licenseUrl("CC-BY-SA")).toBe("https://creativecommons.org/licenses/by-sa/3.0/");
  });

  it("drops the text of a non-free version as soon as the response is read", () => {
    const p = parseTextsResponse(parseSourceRef("Genesis 1:1")!, RESPONSE);
    expect(p.versions.map((v) => [v.language, v.free, v.text?.length ?? null])).toEqual([["he", true, 1], ["en", false, null]]);
    expect(JSON.stringify(p)).not.toContain(EN_NC);
  });

  it("asks Sefaria for the source and its translation as plain text", () => {
    expect(apiUrl(parseSourceRef("בראשית א:א")!)).toBe("https://www.sefaria.org/api/v3/texts/Genesis%201%3A1?version=source&version=translation&return_format=text_only");
  });
});

describe("the quote and the offline copy", () => {
  const ref = parseSourceRef("בראשית א:א")!;
  const passage = parseTextsResponse(ref, RESPONSE);

  it("quotes the free text with every version's licence, a Sefaria link and a verse link", () => {
    const q = quoteBlock(passage);
    expect(q).toContain(HE); // points and cantillation untouched
    expect(q).not.toContain(EN_NC);
    expect(q).toContain("[[Genesis.1.1|בראשית א׳:א׳]]");
    expect(q).toContain("[CC-BY-SA](https://creativecommons.org/licenses/by-sa/3.0/)");
    expect(q).toContain("CC-BY-NC](https://creativecommons.org/licenses/by-nc/4.0/)) — link only");
    expect(q).toContain("(https://www.sefaria.org/Genesis.1.1)");
  });

  it("the saved note records every licence in its frontmatter and holds only free text", () => {
    const md = renderSourceNote(passage, "2026-11-12");
    expect(md).toMatch(/^---\ntype: source\nsource: sefaria\nref: "Genesis 1:1"/);
    expect(md).toContain('license: "CC-BY-SA"');
    expect(md).toContain('license: "CC-BY-NC"');
    expect(md).toContain("copied: false");
    expect(md).toContain(HE);
    expect(md).not.toContain(EN_NC);
    const back = parseSourceNote(md)!;
    expect(back.ref.key).toBe("Genesis.1.1");
    expect(back.versions.map((v) => [v.license, v.free, v.text])).toEqual([["CC-BY-SA", true, [HE]], ["CC-BY-NC", false, null]]);
  });

  it("second lookup, offline: 0 network requests", async () => {
    const storage = memoryStorage();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(RESPONSE), { status: 200, headers: { "content-type": "application/json" } }));
    const first = await lookupPassage(ref, { storage, fetch: fetchSpy as unknown as typeof fetch });
    expect(first.from).toBe("network");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Nothing is stored until the user asks.
    expect(storage.files.size).toBe(0);
    expect(await savePassage(first.passage, storage, "2026-11-12")).toBe(sourceNotePath(ref));
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const second = await lookupPassage(ref, { storage, fetch: offline as unknown as typeof fetch });
    expect(second.from).toBe("vault");
    expect(offline).toHaveBeenCalledTimes(0);
    expect(quoteBlock(second.passage)).toBe(quoteBlock(first.passage));
  });

  it("lists the notes that cite a verse, not the source note itself", () => {
    const notes = [
      { path: "Torah/creation.md", content: "על [[בראשית א:א]] כתב רש״י…" },
      { path: "Torah/other.md", content: "[[שמות כ:ג]]" },
      { path: "Daily/2026-11-12.md", content: quoteBlock(passage) },
      { path: "Sources/Sefaria/Genesis.1.1.md", content: renderSourceNote(passage, "2026-11-12") },
    ];
    expect(notesCiting(ref, notes)).toEqual(["Torah/creation.md", "Daily/2026-11-12.md"]);
  });
});
