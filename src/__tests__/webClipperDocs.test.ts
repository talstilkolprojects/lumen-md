// @vitest-environment node
/**
 * Decision 2.92 (#316): the Web Clipper page (English and Hebrew) matches
 * the extension and its receiver (clip bridge, plan 4.15.2): it no longer
 * says a clip from the extension doesn't reach the vault, and it names the
 * two ways a clip arrives (postMessage to the Lumen tab, a lumen://clip
 * link to the desktop app), with no clip server.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const page = (p: string) => readFileSync(p, "utf8");
const EN = page("docs/src/content/docs/plugins/web-clipper.md");
const HE = page("docs/src/content/docs/he/plugins/web-clipper.md");

describe("Web Clipper docs (decision 2.92)", () => {
  for (const [name, text] of [["en", EN], ["he", HE]] as const) {
    it(`${name}: no longer says the extension doesn't save`, () => {
      expect(text).not.toMatch(/does not save into a vault yet|doesn't arrive in your\s+vault|No Lumen build answers/);
      expect(text).not.toMatch(/עדיין לא שומר לכספת|אף בנייה של Lumen עדיין לא עונה/);
      expect(text).not.toContain(":::caution");
      // The endpoint the old page described never existed.
      expect(text).not.toContain("/api/clip");
    });

    it(`${name}: names both ways a clip reaches Lumen, and no server`, () => {
      expect(text).toContain("`postMessage`");
      expect(text).toContain("lumen://clip");
      expect(text).toMatch(/no clip server|אין שרת גזירה/);
    });

    it(`${name}: keeps the in-app commands`, () => {
      expect(text).toContain("`⌘K → Clip a web page…`");
      expect(text).toContain("`⌘K → Clip from clipboard`");
    });
  }

  it("the Hebrew page uses one term for a clip", () => {
    expect(HE).not.toMatch(/קיצוץ|קוצץ/);
  });

  it("with the clipper v2 in the tree, the code is what the page describes", () => {
    // #316 is based on chore/dod, which still has the v1 extension; the
    // receiver and the v2 extension come with the trains (plan 4.15.2).
    let bridge = "";
    try {
      bridge = page("src/research/clipBridge.ts");
    } catch {
      return;
    }
    expect(bridge).toContain('CLIP_MESSAGE = "lumen-clip-v2"');
    expect(bridge).toContain("lumen-deep-link");
    const bg = page("extension/background.js");
    expect(bg).not.toMatch(/fetch\([^)]*api\/clip/);
    expect(bg).toContain("lumen://clip");
  });
});
