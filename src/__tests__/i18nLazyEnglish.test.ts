/**
 * English of lazily loaded domains (src/i18n/lazy/<domain>.json): kept out
 * of the startup bundle, registered when the domain's chunk loads.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { lazyEnglish, LAZY_DIR } from "./helpers/i18nLazy";
import { registerEnglish, t } from "../i18n";

const SRC = resolve(__dirname, "..");

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

describe("i18n: lazy English", () => {
  const lazy = lazyEnglish();
  const index = readFileSync(join(SRC, "i18n", "index.ts"), "utf8");

  it("has the encrypted-sync strings, none of them duplicated in the startup bundle", () => {
    expect(Object.keys(lazy).length).toBeGreaterThan(10);
    expect(Object.keys(lazy).every((k) => k.startsWith("e2ee."))).toBe(true);
    for (const k of Object.keys(lazy)) expect(index.includes(`"${k}":`), k).toBe(false);
  });

  it("each file is imported only by its own domain's strings module", () => {
    for (const file of readdirSync(LAZY_DIR)) {
      const importers = sources(SRC)
        .filter((f) => readFileSync(f, "utf8").includes(`i18n/lazy/${file}`))
        .map((f) => relative(SRC, f).replace(/\\/g, "/"));
      expect(importers).toEqual(["sync/e2ee/strings.ts"]);
    }
    // …and that module only from inside the lazily loaded src/sync/e2ee/.
    const users = sources(SRC)
      .filter((f) => /from "\.\.?\/(\.\.\/)?strings"|import "\.\.?\/strings"/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f).replace(/\\/g, "/"));
    expect(users.length).toBeGreaterThan(0);
    for (const u of users) expect(u.startsWith("sync/e2ee/")).toBe(true);
  });

  it("registerEnglish makes t() resolve the keys, without replacing existing English", async () => {
    await import("../sync/e2ee/strings");
    expect(t("e2ee.setup.title")).toBe(lazy["e2ee.setup.title"]);
    expect(t("e2ee.setup.tooShort", { n: 12 })).toBe("At least 12 characters.");
    registerEnglish({ "dialog.ok": "replaced?", "test.lazy.only": "lazy" });
    expect(t("dialog.ok")).toBe("OK");
    expect(t("test.lazy.only")).toBe("lazy");
  });
});
