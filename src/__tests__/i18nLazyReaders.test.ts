/**
 * English of lazily loaded domains (src/i18n/lazy/<domain>.json) for the
 * readers: the EPUB reader and reading mode (plan W1.14), and the PDF reader
 * (moved with W1.14). Kept out of the startup bundle, registered when the
 * domain's chunk loads.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { lazyEnglish } from "./helpers/i18nLazy";
import { t } from "../i18n";

const SRC = resolve(__dirname, "..");
const rel = (f: string) => relative(SRC, f).replace(/\\/g, "/");
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
/** Modules (src-relative, no extension) a file imports statically. */
function staticImports(from: string, text: string): string[] {
  return [...text.matchAll(/^import (?!type )(?:[^;]*? from )?"(\.[^"]+)";/gm)].map((m) => rel(resolve(SRC, from, "..", m[1])).replace(/\.tsx?$/, ""));
}

const DOMAINS = [
  { file: "epub.json", module: "epub/strings", prefixes: ["epub.", "reading."], users: ["epub/EpubReader.tsx", "epub/ReadingMode.tsx", "epub/openEpub.ts"] },
  { file: "pdf.json", module: "pdf/strings", prefixes: ["pdf."], users: ["pdf/PdfReader.tsx", "pdf/openPdf.ts"] },
];

describe("i18n: lazy English for the readers (W1.14)", () => {
  const lazy = lazyEnglish();
  const index = readFileSync(join(SRC, "i18n", "index.ts"), "utf8");
  const files = sources(SRC).map((f) => ({ path: rel(f), text: readFileSync(f, "utf8") }));

  it("no lazy key is in the startup bundle; the palette labels are", () => {
    for (const k of Object.keys(lazy)) expect(index.includes(`"${k}":`), k).toBe(false);
    for (const k of ["cmd.epub.open", "cmd.reading.mode", "cmd.pdf.open"]) expect(index.includes(`"${k}":`), k).toBe(true);
  });

  for (const d of DOMAINS) {
    it(`${d.file}: its prefixes, its one importer, and users that load on demand`, () => {
      const own = JSON.parse(readFileSync(join(SRC, "i18n", "lazy", d.file), "utf8")) as Record<string, string>;
      expect(Object.keys(own).length).toBeGreaterThan(10);
      for (const k of Object.keys(own)) expect(d.prefixes.some((p) => k.startsWith(p)), k).toBe(true);
      expect(files.filter((f) => f.text.includes(`i18n/lazy/${d.file}`)).map((f) => f.path)).toEqual([`${d.module}.ts`]);
      expect(files.filter((f) => staticImports(f.path, f.text).includes(d.module)).map((f) => f.path).sort()).toEqual([...d.users].sort());
      const domainDir = d.module.split("/")[0] + "/";
      for (const f of files) {
        if (f.path.startsWith(domainDir)) continue;
        for (const u of d.users) expect(staticImports(f.path, f.text).includes(u.replace(/\.tsx?$/, "")), `${f.path} imports ${u} statically`).toBe(false);
      }
    });
  }

  it("t() resolves them once the domain is loaded", async () => {
    await import("../epub/strings");
    await import("../pdf/strings");
    expect(t("epub.chapterOf", { n: 2, total: 9 })).toBe("Chapter 2 of 9");
    expect(t("pdf.page.of", { n: 1, total: 3 })).toBe("Page 1 of 3");
  });
});
