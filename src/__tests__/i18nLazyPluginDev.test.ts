/**
 * The plugin developer panel's English (src/i18n/lazy/pluginDev.json) ships
 * with the gallery's lazy chunk, not the startup bundle (plan W3.10).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { readLocale } from "../../scripts/lib/i18n-files.mjs";

const SRC = resolve(__dirname, "..");
const lazy = JSON.parse(readFileSync(join(SRC, "i18n", "lazy", "pluginDev.json"), "utf8")) as Record<string, string>;

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

describe("i18n: the plugin developer panel's lazy English", () => {
  it("has only pluginDev.* keys, none of them in the startup bundle, and every locale has them", () => {
    // The startup English: every domain file of locales/en/ (plan 0.3).
    const startup = readLocale("en") as Record<string, string>;
    expect(Object.keys(lazy).length).toBeGreaterThan(20);
    for (const loc of ["he", "ar", "de", "fr", "ja", "ru", "zh-CN"]) {
      const l = readLocale(loc) as Record<string, string>;
      for (const k of Object.keys(lazy)) expect(typeof l[k], `${loc} ${k}`).toBe("string");
    }
    for (const k of Object.keys(lazy)) {
      expect(k.startsWith("pluginDev."), k).toBe(true);
      expect(k in startup, k).toBe(false);
    }
  });

  it("is imported only by its strings module, used only by the lazy gallery's plugin runtime", () => {
    const rel = (f: string) => relative(SRC, f).replace(/\\/g, "/");
    const all = sources(SRC);
    expect(all.filter((f) => readFileSync(f, "utf8").includes("i18n/lazy/pluginDev.json")).map(rel)).toEqual(["plugins/runtime/devStrings.ts"]);
    const users = all.filter((f) => /["']\.\/devStrings["']/.test(readFileSync(f, "utf8"))).map(rel).sort();
    expect(users).toEqual(["plugins/runtime/DevPanel.tsx", "plugins/runtime/SandboxedPlugins.tsx"]);
  });
});
