/**
 * The Yiddish and Ladino strings' English (src/i18n/lazy/jewishLanguages.json)
 * ships with its lazy chunk, not the startup bundle (plan W7.9).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = resolve(__dirname, "..");
const lazy = JSON.parse(readFileSync(join(SRC, "i18n", "lazy", "jewishLanguages.json"), "utf8")) as Record<string, string>;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "__tests__" || e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

describe("i18n: Yiddish and Ladino lazy English", () => {
  it("has only its own keys, none in the startup English", () => {
    const en = readdirSync(join(SRC, "i18n", "locales", "en")).flatMap((f) => Object.keys(JSON.parse(readFileSync(join(SRC, "i18n", "locales", "en", f), "utf8"))));
    for (const k of Object.keys(lazy)) {
      expect(/^(jewishLang|yiddish)\./.test(k), k).toBe(true);
      expect(en.includes(k), k).toBe(false);
    }
  });
  it("is imported only by its strings module, which only the lazy command and spelling modules import", () => {
    const rel = (f: string) => relative(SRC, f).replace(/\\/g, "/");
    const all = sources(SRC);
    expect(all.filter((f) => readFileSync(f, "utf8").includes("i18n/lazy/jewishLanguages.json")).map(rel)).toEqual(["text/jewishLanguagesStrings.ts"]);
    const users = all.filter((f) => /jewishLanguagesStrings["']/.test(readFileSync(f, "utf8"))).map(rel).sort();
    expect(users).toEqual(["ai/yiddishSpellService.ts", "text/jewishLanguageCommands.ts"]);
  });
});
