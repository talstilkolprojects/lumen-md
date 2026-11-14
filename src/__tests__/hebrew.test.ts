/**
 * T26 — Hebrew text core: matching, prefixes, word counts, slugs, note
 * keys, and the places that use them (backlinks, workspace search,
 * backup folder names).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { countWords, hebrewFind, normalizeForMatch, prefixVariants, stripNiqqud, words } from "../text/hebrew";
import { headingSlug, headingSlugger, noteKey } from "../lib/slug";
import { slug as remarkSlug } from "../renderer/remarkLumen";

describe("hebrew text core", () => {
  it("strips niqqud and folds final letters for matching", () => {
    expect(stripNiqqud("שָׁלוֹם")).toBe("שלום");
    expect(stripNiqqud("יוֹם־יוֹם בֵּית־סֵפֶר")).toBe("יום־יום בית־ספר");
    expect(normalizeForMatch("יוֹם־יוֹם")).toBe("יומ-יומ");
    expect(normalizeForMatch("שָׁלוֹם")).toBe(normalizeForMatch("שלומ"));
    expect(normalizeForMatch("צה״ל")).toBe('צה"ל');
    expect(normalizeForMatch("Hello")).toBe("hello");
  });

  it("peels prefix letters into extra search forms", () => {
    expect(prefixVariants("והבית")).toEqual(["והבית", "הבית", "בית"]);
    expect(prefixVariants("שבבית")).toContain("בית");
    // three letters is the floor: "בית" is not peeled to "ית"
    expect(prefixVariants("בית")).toEqual(["בית"]);
    expect(prefixVariants("hello")).toEqual(["hello"]);
    // never peels down to a single letter
    expect(prefixVariants("וב").every((w) => [...w].length >= 2)).toBe(true);
  });

  it("counts a pointed word and a gershayim acronym as one word each", () => {
    expect(countWords("שָׁלוֹם עוֹלָם")).toBe(2);
    expect(countWords("צה״ל ו-Google")).toBe(2);
    expect(countWords("hello, world — 2026!")).toBe(3);
    expect(words("don't stop")).toEqual(["don't", "stop"]);
  });

  it("finds Hebrew regardless of niqqud, finals and prefixes, with offsets in the original", () => {
    const text = "בבוקר הלכנו אל הַבַּיִת הישן";
    const hit = hebrewFind(text, "והבית");
    expect(hit).not.toBeNull();
    expect(text.slice(hit!.start, hit!.end)).toBe("הַבַּיִת");
    expect(hebrewFind("ספר שלום", "שלומ")).not.toBeNull();
    expect(hebrewFind("ספר", "בית")).toBeNull();
    expect(hebrewFind("abc", "")).toBeNull();
  });
});

describe("slugs and note keys", () => {
  it("gives Hebrew headings a real id, the same one rehype-slug uses", () => {
    expect(headingSlug("כותרת ראשית")).toBe("כותרת-ראשית");
    expect(headingSlug("Hello World!")).toBe("hello-world");
    // the wiki-link anchor and the heading id agree
    expect(remarkSlug("כותרת ראשית")).toBe(headingSlug("כותרת ראשית"));
  });

  it("numbers repeated headings like the preview", () => {
    const s = headingSlugger();
    expect([s.slug("פרק"), s.slug("פרק"), s.slug("פרק")]).toEqual(["פרק", "פרק-1", "פרק-2"]);
  });

  it("compares note names without case, niqqud, finals, extension or spacing", () => {
    expect(noteKey("שָׁלוֹם עולם.md")).toBe(noteKey("שלום  עולמ"));
    expect(noteKey("My_Note.md")).toBe(noteKey("my note"));
    expect(noteKey("שלום")).not.toBe(noteKey("עולם"));
  });
});

const files = vi.hoisted(() => new Map<string, string>());
vi.mock("../storage/workspace", async (orig) => ({
  ...(await orig<object>()),
  isOPFSAvailable: () => true,
  listWorkspace: vi.fn(async () => [...files.keys()].map((path) => ({ path, name: path.split("/").pop()!, size: 0, modified: 1, kind: "file" }))),
  readWorkspaceFile: vi.fn(async (p: string) => files.get(p) ?? ""),
}));

describe("backlinks and workspace search", () => {
  beforeEach(async () => {
    files.clear();
    files.set("שלום.md", "# שלום");
    files.set("עולם.md", "# עולם");
    files.set("a.md", "ראו [[שלום]] וגם [[שָׁלוֹם#פרק|כאן]].");
    files.set("b.md", "קישור אל [[עולם]] בלבד.");
    files.set("c.md", "בבוקר הלכנו אל הַבַּיִת הישן");
    window.dispatchEvent(new Event("lumen-workspace-changed"));
  });

  it("finds only the notes that link to this Hebrew note", async () => {
    const { findBacklinks } = await import("../storage/workspaceIndex");
    const hits = await findBacklinks("שלום.md");
    expect(hits.map((h) => h.fromPath)).toEqual(["a.md", "a.md"]);
    const others = await findBacklinks("עולם.md");
    expect(others.map((h) => h.fromPath)).toEqual(["b.md"]);
  });

  it("search finds a pointed, prefixed word and highlights it in the snippet", async () => {
    const { searchWorkspace } = await import("../storage/workspaceIndex");
    const hits = await searchWorkspace("והבית");
    const c = hits.find((h) => h.path === "c.md");
    expect(c).toBeTruthy();
    expect(c!.snippet!.slice(c!.match!.start, c!.match!.end)).toBe("הַבַּיִת");
  });
});
