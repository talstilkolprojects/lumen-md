/**
 * The plugin permission screens' English (src/i18n/lazy/pluginTrust.json)
 * ships with its lazy chunk, not the startup bundle (plan W1.20).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = resolve(__dirname, "..");
const lazy = JSON.parse(readFileSync(join(SRC, "i18n", "lazy", "pluginTrust.json"), "utf8")) as Record<string, string>;

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

describe("i18n: the plugin trust screens' lazy English", () => {
  it("has only pluginTrust.* keys, none of them in the startup bundle", () => {
    const index = readFileSync(join(SRC, "i18n", "index.ts"), "utf8");
    expect(Object.keys(lazy).length).toBeGreaterThan(30);
    for (const k of Object.keys(lazy)) {
      expect(k.startsWith("pluginTrust."), k).toBe(true);
      expect(index.includes(`"${k}":`), k).toBe(false);
    }
  });

  it("is imported only by its strings module, and that only inside the lazy plugin runtime", () => {
    const rel = (f: string) => relative(SRC, f).replace(/\\/g, "/");
    const all = sources(SRC);
    expect(all.filter((f) => readFileSync(f, "utf8").includes("i18n/lazy/pluginTrust.json")).map(rel)).toEqual(["plugins/runtime/trustStrings.ts"]);
    const users = all.filter((f) => /["']\.\/trustStrings["']/.test(readFileSync(f, "utf8"))).map(rel);
    expect(users).toEqual(["plugins/runtime/permissions.ts"]);
  });
});
