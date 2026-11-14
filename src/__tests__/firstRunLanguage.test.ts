/**
 * W4.35 — Hebrew by default when the system lists Hebrew, one question when
 * it doesn't: the plan, the order of the choices, and no English left in
 * the Hebrew first run (every string the dialog shows has Hebrew).
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { languageOrder, languagePlan } from "../onboarding/setup";
import { detectLocale, systemHasHebrew } from "../i18n/detect";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("the language plan", () => {
  it("Hebrew anywhere in the system's list: Hebrew, no question", () => {
    for (const langs of [["he-IL"], ["he"], ["iw-IL"], ["en-US", "he-IL"], ["ru", "en", "he"]]) expect(languagePlan(langs), langs.join()).toEqual({ ask: false, locale: "he" });
  });

  it("otherwise one question, with the system's language suggested", () => {
    expect(languagePlan(["en-US"])).toEqual({ ask: true, locale: "en" });
    expect(languagePlan(["fr-FR", "en"])).toEqual({ ask: true, locale: "fr" });
    expect(languagePlan(["xx"])).toEqual({ ask: true, locale: "en" });
    expect(languagePlan([])).toEqual({ ask: true, locale: "en" });
  });

  it("no false Hebrew: 'hr' (Croatian), 'hu', 'hi' are not Hebrew", () => {
    expect(systemHasHebrew(["hr-HR", "hu", "hi-IN", "heb"])).toBe(false);
    expect(detectLocale(null, ["hr-HR"])).toBe("en");
  });

  it("the choices put Hebrew first, then English, then the rest in their order", () => {
    const list = [{ code: "en" }, { code: "he" }, { code: "ar" }, { code: "ru" }];
    expect(languageOrder(list).map((l) => l.code)).toEqual(["he", "en", "ar", "ru"]);
  });
});

describe("the dialog", () => {
  const src = read("src/onboarding/FirstRun.tsx");
  const en = read("src/i18n/index.ts");
  const he = JSON.parse(read("src/i18n/locales/he.json")) as Record<string, string>;

  it("skips the language step when no question is asked, and keeps a way to change it", () => {
    expect(src).toMatch(/const STEPS = showLang \? ALL_STEPS : ALL_STEPS\.filter\(\(s\) => s !== "lang"\)/);
    expect(src).toMatch(/useState\(\(\) => plan\.ask \|\| !setupDue\(\)\)/);
    expect(src).toContain('data-testid="first-run-change-language"');
    expect(src).toContain('t("onboard.lang.write")');
  });

  it("every string the Hebrew first run shows is in Hebrew (0 English strings)", () => {
    const keys = new Set<string>();
    for (const m of src.matchAll(/\bt\(\s*[`"]([\w.:-]+)(?:\$\{[^}]+\})?[^`"]*[`"]/g)) keys.add(m[1]);
    // Template keys built from lists: the themes and the presets.
    for (const th of ["light", "dark", "system"]) keys.add(`onboard.style.${th}`);
    for (const m of read("src/lib/themeSettings.ts").matchAll(/PRESET_IDS[^=]*=\s*\[([^\]]+)\]/g)) for (const id of m[1].matchAll(/"(\w+)"/g)) keys.add(`themeSettings.preset.${id[1]}`);
    keys.delete("onboard.style.");
    keys.delete("themeSettings.preset.");
    // Words that stay in Latin letters in Hebrew text: names of products and formats.
    const allowed = /\b(Lumen|Obsidian|Notion|Markdown|zip|OPFS|Nord|Chrome|Edge|Safari|Firefox)\b/g;
    const missing: string[] = [];
    for (const k of keys) {
      if (!new RegExp(`"${k.replace(/\./g, "\\.")}":`).test(en)) continue; // not a string key (e.g. a prefix)
      const v = he[k];
      if (!v || !/[֐-׿]/.test(v) || /[A-Za-z]{3,}/.test(v.replace(allowed, "").replace(/\{\w+\}/g, ""))) missing.push(`${k}: ${v}`);
    }
    expect(missing).toEqual([]);
    expect(keys.size).toBeGreaterThan(25);
  });
});
