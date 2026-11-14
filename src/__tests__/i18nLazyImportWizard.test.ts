/**
 * The import wizard's English (src/i18n/lazy/importWizard.json) ships with
 * its lazy chunk, not the startup bundle (plan W1.26).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { t } from "../i18n";

const SRC = resolve(__dirname, "..");
const lazy = JSON.parse(readFileSync(join(SRC, "i18n", "lazy", "importWizard.json"), "utf8")) as Record<string, string>;

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

describe("i18n: the import wizard's lazy English", () => {
  it("has only importWizard.* keys, none of them in the startup bundle", () => {
    const index = readFileSync(join(SRC, "i18n", "index.ts"), "utf8");
    expect(Object.keys(lazy).length).toBeGreaterThan(40);
    for (const k of Object.keys(lazy)) {
      expect(k.startsWith("importWizard."), k).toBe(true);
      expect(index.includes(`"${k}":`), k).toBe(false);
    }
  });

  it("every reason, warning and source the code can name has its words", () => {
    for (const r of ["appFolder", "trashed", "duplicate", "unsupported", "empty", "unreadable", "encrypted"]) expect(lazy[`importWizard.reason.${r}`], r).toBeDefined();
    for (const w of ["missingAttachment", "encryptedPart", "noDates"]) expect(lazy[`importWizard.warn.${w}`], w).toBeDefined();
    for (const s of ["obsidian", "notion", "evernote", "bear", "appleNotes", "keep", "logseq", "onenote", "lumen"]) expect(lazy[`importWizard.how.${s}`], s).toBeDefined();
  });

  it("is imported only by its strings module, which only lazily loaded modules import", () => {
    const rel = (f: string) => relative(SRC, f).replace(/\\/g, "/");
    const all = sources(SRC);
    expect(all.filter((f) => readFileSync(f, "utf8").includes("i18n/lazy/importWizard.json")).map(rel)).toEqual(["storage/import/strings.ts"]);
    const users = all.filter((f) => readFileSync(f, "utf8").includes("storage/import/strings") || (rel(f).startsWith("storage/import/") && readFileSync(f, "utf8").includes('"./strings"'))).map(rel);
    // The palette's vault actions (split out of useCommands, train 2) and the wizard, which now sits in storage/import/.
    expect(users.sort()).toEqual(["commands/domains/vaultActions.ts", "storage/import/ImportWizard.tsx", "storage/import/report.ts"]);
    // The vault actions load it with a dynamic import(), never statically.
    expect(readFileSync(join(SRC, "commands", "domains", "vaultActions.ts"), "utf8")).not.toMatch(/^import [^;]*storage\/import\/strings/m);
  });

  it("registers when the report module loads", async () => {
    expect(t("importWizard.title")).toBe("importWizard.title");
    await import("../storage/import/report");
    expect(t("importWizard.title")).toBe(lazy["importWizard.title"]);
    expect(t("importWizard.reading", { n: 3 })).toBe("Reading 3 files…");
  });
});
