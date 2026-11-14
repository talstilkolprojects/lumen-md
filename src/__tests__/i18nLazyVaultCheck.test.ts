/**
 * The vault integrity check's English (src/i18n/lazy/vaultCheck.json) ships
 * with its lazy chunk, not the startup bundle (plan W1.5).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { t } from "../i18n";

const SRC = resolve(__dirname, "..");
const lazy = JSON.parse(readFileSync(join(SRC, "i18n", "lazy", "vaultCheck.json"), "utf8")) as Record<string, string>;

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

describe("i18n: the vault check's lazy English", () => {
  it("has only vaultCheck.* keys, none of them in the startup bundle", () => {
    const index = readFileSync(join(SRC, "i18n", "index.ts"), "utf8");
    expect(Object.keys(lazy).length).toBeGreaterThan(20);
    for (const k of Object.keys(lazy)) {
      expect(k.startsWith("vaultCheck."), k).toBe(true);
      expect(index.includes(`"${k}":`), k).toBe(false);
    }
  });

  it("is imported only by its strings module, which only the lazy report module imports", () => {
    const rel = (f: string) => relative(SRC, f).replace(/\\/g, "/");
    const all = sources(SRC);
    expect(all.filter((f) => readFileSync(f, "utf8").includes("i18n/lazy/vaultCheck.json")).map(rel)).toEqual(["storage/vault/integrityStrings.ts"]);
    expect(all.filter((f) => /["']\.\/integrityStrings["']/.test(readFileSync(f, "utf8"))).map(rel)).toEqual(["storage/vault/integrityReport.ts"]);
  });

  it("registers when the report module loads", async () => {
    expect(t("vaultCheck.title")).toBe("vaultCheck.title");
    await import("../storage/vault/integrityReport");
    expect(t("vaultCheck.title")).toBe(lazy["vaultCheck.title"]);
    expect(t("vaultCheck.more", { n: 3 })).toBe("… and 3 more");
  });
});
