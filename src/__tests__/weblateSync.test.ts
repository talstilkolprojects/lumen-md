/**
 * Two-way sync with Hosted Weblate (plan W6.32): the config keeps Weblate's
 * JSON writer byte-compatible with the locale layout, the English base holds
 * the lazy strings too (so Weblate's cleanup add-on cannot drop their
 * translations), and nothing in the files would show up empty.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const config = JSON.parse(readFileSync(join(ROOT, "i18n/weblate/config.json"), "utf8")) as {
  component: { file_format: string; file_format_params: Record<string, unknown>; addons: string[]; language_regex: string; template: string; filemask: string };
  languages: string[];
  first: string;
};
const LOCALES = join(ROOT, "src/i18n/locales");
const langs = readdirSync(LOCALES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

describe("Weblate sync (W6.32)", () => {
  it("scripts/weblate.mjs --check passes on the repository", () => {
    const out = execFileSync(process.execPath, [join(ROOT, "scripts/weblate.mjs"), "--check"], { cwd: ROOT, encoding: "utf8" });
    expect(out).toMatch(/✓ Weblate: 8 components/);
  });

  it("asks Weblate for the layout's JSON: 2 spaces, sorted keys, flat", () => {
    expect(config.component.file_format).toBe("json");
    expect(config.component.file_format_params).toMatchObject({ json_indent: 2, json_indent_style: "spaces", json_sort_keys: "case_sensitive", json_use_compact_separators: false });
    for (const a of ["weblate.cleanup.generic", "weblate.cleanup.blank"]) expect(config.component.addons).toContain(a);
  });

  it("every key is ASCII, so Weblate's sort (Python, code points) and the layout's (JavaScript, UTF-16 units) agree", () => {
    for (const lang of langs)
      for (const f of readdirSync(join(LOCALES, lang))) {
        if (!f.endsWith(".json")) continue;
        for (const k of Object.keys(JSON.parse(readFileSync(join(LOCALES, lang, f), "utf8")))) expect(/^[\x20-\x7e]+$/.test(k), `${lang}/${f}: ${k}`).toBe(true);
      }
  });

  it("the English base holds every key a translation has, so cleanup keeps the lazy screens' translations", () => {
    const base: Record<string, string> = {};
    for (const f of readdirSync(join(ROOT, "i18n/weblate/en"))) Object.assign(base, JSON.parse(readFileSync(join(ROOT, "i18n/weblate/en", f), "utf8")));
    const ar: Record<string, string> = {};
    for (const f of readdirSync(join(LOCALES, "ar"))) Object.assign(ar, JSON.parse(readFileSync(join(LOCALES, "ar", f), "utf8")));
    const lost = Object.keys(ar).filter((k) => !(k in base));
    expect(lost).toEqual([]);
    expect(Object.keys(base).length).toBeGreaterThan(Object.keys(JSON.parse(readFileSync(join(LOCALES, "en", "common.json"), "utf8"))).length);
  });

  it("leaves English out of the translated languages, takes every other one, and starts with Arabic", () => {
    const re = new RegExp(config.component.language_regex);
    expect(re.test("en")).toBe(false);
    for (const l of langs.filter((x) => x !== "en")) expect(re.test(l), l).toBe(true);
    expect(config.first).toBe("ar");
    expect(config.languages[0]).toBe("ar");
  });
});
