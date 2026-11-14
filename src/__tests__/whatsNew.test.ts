/**
 * Plan 14.6 — "What's new": the version's notes from the changelog (13.4) in
 * the interface's language, shown once per version (never on a fresh
 * install), and the release script keeping the translations in step.
 */
import { describe, it, expect } from "vitest";
import { addUntranslated, forReaders, localizeHeadings, versionSection, whatsNew, UNTRANSLATED } from "../../scripts/lib/whats-new.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { changelogSection, insertChangelog } from "../../scripts/lib/release.mjs";
import { decide, notesFor, SEEN_KEY, type Storage } from "../whatsNew/check";

const commits = [
  { type: "feat", scope: "canvas", subject: "note cards on the canvas", hash: "a".repeat(40), breaking: false },
  { type: "fix", scope: null, subject: "Hebrew in SVG export", hash: "b".repeat(40), breaking: false },
];
const section = changelogSection("1.2.0", commits, { date: new Date("2026-11-10T00:00:00Z"), repo: "o/r" });
const english = insertChangelog("# Changelog\n\n## [Unreleased]\n\n- wip\n\n## [1.1.0] - 2026-10-01\n\n### Added\n\n- older\n", section);

const mem = (init: Record<string, string> = {}): Storage & { data: Record<string, string> } => {
  const data = { ...init };
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => void (data[k] = v) };
};

describe("notes from the changelog (14.6)", () => {
  it("one version's section, for readers: no commit links, no scopes", () => {
    expect(versionSection(english, "1.2.0")).toMatchObject({ date: "2026-11-10" });
    expect(forReaders(versionSection(english, "1.2.0")!.body)).toBe("### Added\n\n- note cards on the canvas\n\n### Fixed\n\n- Hebrew in SVG export");
    expect(versionSection(english, "9.9.9")).toBeNull();
    expect(versionSection(english, "1.1.0")!.body).toBe("### Added\n\n- older");
    expect(forReaders("### Added\n- a\n\n[Unreleased]: https://x.org/compare\n[0.1.0]: https://x.org/tag")).toBe("### Added\n- a");
  });

  it("a translated section is used; an untranslated one falls back to English under the language's headings", () => {
    const heFile = addUntranslated("# יומן שינויים\n", section);
    expect(heFile).toContain(`## [1.2.0] - 2026-11-10\n\n${UNTRANSLATED}\n`);
    let n = whatsNew("1.2.0", english, { he: heFile })!;
    expect(n.notes.he).toEqual({ markdown: "### חדש\n\n- note cards on the canvas\n\n### תוקן\n\n- Hebrew in SVG export", translated: false });
    const translated = heFile.replace(UNTRANSLATED + "\n", "").replace("- **canvas:** note cards on the canvas", "- כרטיסי פתקים בקנבס").replace(/- Hebrew in SVG export[^\n]*/, "- עברית בייצוא SVG").replace("### Added", "### חדש").replace("### Fixed", "### תוקן");
    n = whatsNew("1.2.0", english, { he: translated })!;
    expect(n.notes.he).toEqual({ markdown: "### חדש\n\n- כרטיסי פתקים בקנבס\n\n### תוקן\n\n- עברית בייצוא SVG", translated: true });
    expect(n.notes.ja.translated).toBe(false);
    expect(Object.keys(n.notes).sort()).toEqual(["ar", "de", "en", "fr", "he", "ja", "ru", "zh-CN"]);
    expect(whatsNew("3.0.0", english)).toBeNull();
    expect(localizeHeadings("### Performance\n- x", "de")).toBe("### Leistung\n- x");
  });

  it("the notes for the interface's locale, else its language, else English", () => {
    const n = whatsNew("1.2.0", english)!;
    expect(notesFor(n, "he")!.markdown).toContain("### חדש");
    expect(notesFor(n, "zh-CN")!.markdown).toContain("### 新增");
    expect(notesFor(n, "pt-BR")!.markdown).toContain("### Added");
    expect(notesFor(null, "he")).toBeNull();
  });
});

describe("once per version (14.6)", () => {
  it("an update shows the notes once; the same version never again; the next version once more", () => {
    const s = mem({ "lumen-tour-done": "1", [SEEN_KEY]: "1.1.0" });
    expect(decide("1.2.0", s, true)).toBe("show");
    expect(s.data[SEEN_KEY]).toBe("1.2.0");
    expect(decide("1.2.0", s, true)).toBe("skip");
    expect(decide("1.3.0", s, true)).toBe("show");
  });

  it("a fresh install shows nothing but remembers the version; an old install without the mark is an update", () => {
    const fresh = mem();
    expect(decide("1.2.0", fresh, true)).toBe("skip");
    expect(fresh.data[SEEN_KEY]).toBe("1.2.0");
    expect(decide("1.2.0", mem({ "lumen-md": "{}" }), true)).toBe("show");
  });

  it("no notes for this version: nothing shown, still counted as seen; storage that throws: nothing shown", () => {
    const s = mem({ "lumen-tour-done": "1", [SEEN_KEY]: "1.1.0" });
    expect(decide("1.2.0", s, false)).toBe("skip");
    expect(s.data[SEEN_KEY]).toBe("1.2.0");
    expect(decide("1.2.0", { getItem: () => { throw new Error("blocked"); }, setItem: () => {} }, true)).toBe("skip");
  });
});
