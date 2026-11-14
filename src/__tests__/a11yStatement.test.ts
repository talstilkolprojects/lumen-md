/**
 * The accessibility statement (plan W1.23, IS 5568 / regulation 35) is
 * published in English and Hebrew and kept current: its version is the
 * app's version, it has a review date, and it has the parts the
 * regulation asks for (standard and level, what is accessible, known
 * gaps, how to report a barrier). A release that bumps the version without
 * reviewing the statement fails here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(__dirname, "..", "..");
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const page = (rel: string) => readFileSync(join(root, "docs", "src", "content", "docs", rel), "utf8");
const front = (md: string) => {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  const out: Record<string, string> = {};
  for (const line of (m?.[1] ?? "").split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
};

const PAGES = [
  { file: "editor/accessibility-statement.md", sections: ["## Standard", "## What is accessible", "## Known gaps", "## Report a barrier"], standard: ["5568", "WCAG 2.0", "AA"] },
  { file: "he/editor/accessibility-statement.md", sections: ["## התקן", "## מה נגיש", "## פערים ידועים", "## דיווח על חסם"], standard: ["5568", "WCAG 2.0", "AA"] },
];

describe("accessibility statement (W1.23)", () => {
  for (const p of PAGES) {
    it(`${p.file}: the app's version, a review date, and every required part`, () => {
      const md = page(p.file);
      const fm = front(md);
      expect(fm.appVersion, "appVersion in the statement must be package.json's version — review the statement for this release").toBe(version);
      expect(fm.reviewed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(md).toContain(version);
      for (const s of p.sections) expect(md, s).toContain(s);
      for (const s of p.standard) expect(md, s).toContain(s);
    });
  }

  it("both languages carry the same version and review date", () => {
    const en = front(page(PAGES[0].file));
    const he = front(page(PAGES[1].file));
    expect(he.appVersion).toBe(en.appVersion);
    expect(he.reviewed).toBe(en.reviewed);
  });

  it("the screen reader protocol lists the four setups in both languages", () => {
    for (const f of ["editor/screen-reader-protocol.md", "he/editor/screen-reader-protocol.md"]) {
      const md = page(f);
      for (const sr of ["NVDA", "VoiceOver / macOS", "VoiceOver / iOS", "TalkBack"]) expect(md, `${f} ${sr}`).toContain(sr);
    }
  });
});
