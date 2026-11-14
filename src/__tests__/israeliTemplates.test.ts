/**
 * W3.6 — the template gallery's Israeli templates, their companion Bases
 * views, the sample vaults, and importing a template from a file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { installFakeOpfs } from "./helpers/fakeOpfs";
import { basesFileFromText, buildVault, parseBase, runBase } from "../views/bases/base";
import { expandTemplate, hebrewDateOf, isoDate } from "../editor/templateVars";
import { SAMPLE_VAULT_IDS, createSampleVault, sampleVault, type SampleVaultLang } from "../storage/sampleVaults";
import { SAMPLE_VAULT_BASES } from "../storage/sampleVaultBases";
import { importTemplateFile, installTemplate, localizeTemplate, safeFileStem, type MarketplaceTemplate } from "../storage/templateMarketplace";
import { listWorkspace, readWorkspaceFile, workspaceHasFile, writeWorkspaceFile } from "../storage/workspace";

const ROOT = join(__dirname, "..", "..");
const PUBLIC = join(ROOT, "public");
const read = (p: string) => readFileSync(join(PUBLIC, p), "utf8");
const registry = JSON.parse(read("templates/registry.json")) as { templates: MarketplaceTemplate[] };
const israeli = registry.templates.filter((t) => t.id.startsWith("il-"));
const lazyStrings = JSON.parse(readFileSync(join(ROOT, "src/i18n/lazy/templates.json"), "utf8")) as Record<string, string>;
const he = JSON.parse(readFileSync(join(ROOT, "src/i18n/locales/he.json"), "utf8")) as Record<string, string>;
const HEBREW = /[֐-׿]/;
const FM = /^---\n([\s\S]*?)\n---\n/;
const NOW = new Date(2026, 10, 10, 9, 30);

const fill = (body: string, title: string, locale = "en") => expandTemplate(body, { title, now: NOW, locale });
const frontmatter = (text: string): Record<string, unknown> => {
  const m = FM.exec(text);
  if (!m) throw new Error("no frontmatter");
  return YAML.parse(m[1]) as Record<string, unknown>;
};

describe("Israeli templates in the registry", () => {
  it("has 20, with unique ids and every file in place", () => {
    expect(israeli.length).toBe(20);
    expect(new Set(registry.templates.map((t) => t.id)).size).toBe(registry.templates.length);
    for (const t of israeli) {
      for (const url of [t.url, t.url_he, t.base, t.base_he]) {
        expect(typeof url).toBe("string");
        expect(existsSync(join(PUBLIC, url!)), `${t.id}: ${url}`).toBe(true);
      }
      expect(t.name_he).toMatch(HEBREW);
      expect(t.description_he).toMatch(HEBREW);
      expect(t.base_name_he).toMatch(HEBREW);
      expect(t.base_name).toBeTruthy();
    }
  });

  it("names every category in English and Hebrew", () => {
    for (const c of new Set(registry.templates.map((t) => t.category))) {
      expect(lazyStrings[`templates.category.${c}`], c).toBeTruthy();
      expect(he[`templates.category.${c}`], c).toMatch(HEBREW);
    }
  });

  it("localizes the companion base with the template", () => {
    const course = israeli.find((t) => t.id === "il-course")!;
    const local = localizeTemplate(course, "he");
    expect(local.url).toBe(course.url_he);
    expect(local.base).toBe(course.base_he);
    expect(local.base_name).toBe("קורסים");
    expect(localizeTemplate(local, "he")).toEqual(local);
    expect(localizeTemplate(course, "en")).toBe(course);
  });
});

describe.each(["en", "he"] as const)("each template (%s)", (lang) => {
  const urlOf = (t: MarketplaceTemplate) => (lang === "he" ? t.url_he! : t.url);
  const baseOf = (t: MarketplaceTemplate) => (lang === "he" ? t.base_he! : t.base!);

  it("has frontmatter that is valid YAML once its placeholders are filled", () => {
    for (const t of israeli) {
      const fm = frontmatter(fill(read(urlOf(t)), "Note", lang));
      expect(typeof fm.type, t.id).toBe("string");
      expect(Array.isArray(fm.tags), t.id).toBe(true);
    }
  });

  it("is Obsidian-compatible: English keys, scalar or list properties, plain Markdown", () => {
    for (const t of israeli) {
      const text = read(urlOf(t));
      const fm = frontmatter(fill(text, "Note", lang));
      for (const [k, v] of Object.entries(fm)) {
        expect(k, `${t.id}: key ${k}`).toMatch(/^[a-z][a-z_]*$/);
        const ok = v === null || ["string", "number", "boolean"].includes(typeof v) || v instanceof Date || (Array.isArray(v) && v.every((x) => typeof x !== "object"));
        expect(ok, `${t.id}: ${k}`).toBe(true);
      }
      expect(text, t.id).not.toMatch(/^:::/m); // Lumen-only callouts
      expect(text, t.id).not.toMatch(/==[^=\n]+==/); // highlight syntax
      expect(text, t.id).not.toMatch(/<[a-z][^>]*>/i); // raw HTML
      for (const m of text.matchAll(/\[\[([^\]]*)\]\]/g)) expect(m[1], t.id).toMatch(/^[^#^|[\]]+$/);
      const unknown = [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).filter((n) => !["title", "date", "time", "hebrewDate"].includes(n));
      expect(unknown, t.id).toEqual([]);
    }
  });

  it("has the same property keys in English and Hebrew", () => {
    for (const t of israeli) {
      const en = Object.keys(frontmatter(fill(read(t.url), "N")));
      const hebrew = Object.keys(frontmatter(fill(read(t.url_he!), "N", "he")));
      expect(hebrew, t.id).toEqual(en);
    }
  });

  it("has a companion base that parses and lists a note made from the template", () => {
    for (const t of israeli) {
      const parsed = parseBase(read(baseOf(t)));
      expect(parsed.ok, t.id).toBe(true);
      if (!parsed.ok) continue;
      const note = basesFileFromText(`Notes/${t.id}.md`, fill(read(urlOf(t)), "From the template", lang));
      const other = basesFileFromText("Notes/other.md", "---\ntype: something-else\n---\n# x\n");
      const result = runBase(parsed.base, [note, other]);
      expect(result.errors, t.id).toEqual([]);
      expect(result.rows.map((r) => r.file.path), t.id).toEqual([note.path]);
      if (lang === "he") for (const label of Object.values(parsed.base.displayNames)) expect(label, t.id).toMatch(HEBREW);
    }
  });
});

describe("template placeholders", () => {
  it("fills title, date, time and the Hebrew date, and leaves others alone", () => {
    const out = expandTemplate("# {{title}}\n{{date}} {{ time }} · {{hebrewDate}} · {{value}}", { title: "Week 1", now: NOW, locale: "he" });
    expect(out).toContain("# Week 1");
    expect(out).toContain("2026-11-10 09:30");
    expect(out).toContain("{{value}}");
    expect(out).not.toContain("{{hebrewDate}}");
    expect(isoDate(NOW)).toBe("2026-11-10");
  });

  it("writes the Hebrew date with the platform's Hebrew calendar", () => {
    expect(hebrewDateOf(NOW, "he")).toMatch(/חשוון/);
    expect(hebrewDateOf(NOW, "en")).toMatch(/5787/);
  });
});

describe.each(SAMPLE_VAULT_IDS.flatMap((id) => (["he", "en"] as SampleVaultLang[]).map((lang) => [id, lang] as const)))("sample vault %s (%s)", (id, lang) => {
  const vault = sampleVault(id, lang);
  const files = vault.files.map((f) => basesFileFromText(`${vault.root}/${f.path}`, f.path.endsWith(".base") ? null : f.content));

  it("resolves every wiki-link", () => {
    const resolver = buildVault(files);
    for (const f of vault.files) {
      for (const m of f.content.matchAll(/\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g)) {
        expect(resolver.resolve(m[1]), `${f.path}: [[${m[1]}]]`).not.toBeNull();
      }
    }
  });

  it("runs every base without errors, with rows", () => {
    const bases = vault.files.filter((f) => f.path.endsWith(".base"));
    expect(bases.length).toBeGreaterThanOrEqual(2);
    for (const b of bases) {
      const parsed = parseBase(b.content);
      expect(parsed.ok, b.path).toBe(true);
      if (!parsed.ok) continue;
      const result = runBase(parsed.base, files);
      expect(result.errors, b.path).toEqual([]);
      expect(result.rows.length, b.path).toBeGreaterThan(0);
    }
  });

  it(`is written in ${lang === "he" ? "Hebrew" : "English"}`, () => {
    const entry = vault.files.find((f) => f.path === vault.entry)!;
    if (lang === "he") expect(entry.content).toMatch(HEBREW);
    else expect(entry.content).not.toMatch(HEBREW);
  });
});

describe("sample vault bases", () => {
  it("are the gallery's own .base files", () => {
    for (const [id, text] of Object.entries(SAMPLE_VAULT_BASES)) {
      expect(text.en, id).toBe(read(`templates/bases/${id}.base`));
      expect(text.he, id).toBe(read(`templates/he/bases/${id}.base`));
    }
  });
});

describe("writing to the workspace", () => {
  beforeEach(() => {
    installFakeOpfs();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads all six sample vaults in under 2 seconds, and never overwrites", async () => {
    const t0 = performance.now();
    for (const id of SAMPLE_VAULT_IDS) {
      await createSampleVault(id, "he");
      await createSampleVault(id, "en");
    }
    expect(performance.now() - t0).toBeLessThan(2000);
    const vault = sampleVault("student", "he");
    const entry = `${vault.root}/${vault.entry}`;
    await writeWorkspaceFile(entry, "my edits");
    const again = await createSampleVault("student", "he");
    expect(again.created).toEqual([]);
    expect(again.skipped.length).toBe(vault.files.length);
    expect(await readWorkspaceFile(entry)).toBe("my edits");
    expect(again.entry).toBe(entry);
  });

  it("imports a template from a file under a safe, unused name", async () => {
    const first = await importTemplateFile("מתכון: סבתא/שבת.md", "# {{title}}\n");
    expect(first.path).toBe("templates/מתכון סבתא שבת.md");
    const second = await importTemplateFile("מתכון: סבתא/שבת.md", "# again\n");
    expect(second.path).toBe("templates/מתכון סבתא שבת 2.md");
    expect(await readWorkspaceFile(first.path)).toBe("# {{title}}\n");
    await expect(importTemplateFile("notes.txt", "x")).rejects.toThrow();
    expect(safeFileStem("..hidden.md")).toBe("hidden");
    expect(safeFileStem("a#b^c[d]")).toBe("a b c d");
  });

  it("installs a template's companion base once, and keeps the user's edits", async () => {
    const course = localizeTemplate(israeli.find((t) => t.id === "il-course")!, "he");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input).replace(/^\//, "");
      return new Response(read(url), { status: 200 });
    });
    const res = await installTemplate(course);
    expect(res.path).toBe("templates/il-course.md");
    expect(res.basePath).toBe("Bases/קורסים.base");
    expect(await readWorkspaceFile(res.basePath!)).toBe(read("templates/he/bases/il-course.base"));
    await writeWorkspaceFile(res.basePath!, "edited");
    await installTemplate(course);
    expect(await readWorkspaceFile(res.basePath!)).toBe("edited");
    expect(await workspaceHasFile("templates/il-course.md")).toBe(true);
    expect((await listWorkspace()).some((e) => e.path === "Bases/קורסים.base")).toBe(true);
  });
});
