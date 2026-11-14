/**
 * Plan W7.9: Yiddish spelling with a user-downloaded Hunspell list — the
 * words checked, the forms looked up, the pinned download (SHA-256), and
 * the list never in the app's own files.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { isKnownYiddish, lookupForms, yiddishSpelling, yiddishWords, type SpellChecker } from "../ai/yiddishSpell";
import { normalizeYiddish } from "../text/yiddish";

const ROOT = resolve(__dirname, "../..");
const LIST = new Set(["יידיש", "איז", "אַ", "שפּראַך", "וואָרט"].map(normalizeYiddish));
const spell: SpellChecker = {
  correct: (w) => LIST.has(w),
  suggest: (w) => (w === normalizeYiddish("שפראך") ? [normalizeYiddish("שפּראַך")] : []),
};

describe("Yiddish spelling (W7.9)", () => {
  it("checks prose words only, with their offsets", () => {
    const text = "ייִדיש `קאָד` איז [[לינק]] אַ שפראך";
    const words = yiddishWords(text).map((w) => w.word);
    expect(words).toEqual(["ייִדיש", "איז", "אַ", "שפראך"].filter((w) => w.length >= 2));
  });

  it("looks up YIVO's ייִ as the list's יי, and precomposed letters as base + point", () => {
    expect(lookupForms("ייִדיש")).toContain("יידיש");
    expect(isKnownYiddish(spell, "ייִדיש")).toBe(true);
    expect(isKnownYiddish(spell, "אַ")).toBe(true);
  });

  it("flags an unknown word with the list's suggestions", () => {
    const m = yiddishSpelling(spell, "ייִדיש איז אַ שפראך");
    expect(m).toHaveLength(1);
    expect(m[0].offset).toBe("ייִדיש איז אַ ".length);
    expect(m[0].replacements).toEqual([normalizeYiddish("שפּראַך")]);
    expect(m[0].rule.id).toBe("YI_SPELL");
  });

  it("the GPL list is never one of the app's files, and the licence gate knows it as a user download", () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    const files = existsSync(join(ROOT, "public")) ? walk(join(ROOT, "public")) : [];
    expect(files.filter((f) => /(^|\/)yi\.(dic|aff)(\.txt)?$/.test(f))).toEqual([]);
    const reg = JSON.parse(readFileSync(join(ROOT, "models/registry.json"), "utf8")) as { models: { id: string; class: string; delivery: string; license: string }[] };
    expect(reg.models.find((m) => m.id === "hunspell-yi-dictionary")).toMatchObject({ class: "forbidden", delivery: "user-download", license: "GPL-3.0-only" });
  });
});
