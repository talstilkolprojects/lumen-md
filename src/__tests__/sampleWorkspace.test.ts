/**
 * LAUNCH-READINESS B6 — "Open sample workspace".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { readLocale } from "../../scripts/lib/i18n-files.mjs";

const files = new Map<string, string>();
vi.mock("../storage/workspace", async (orig) => {
  const real = await orig<typeof import("../storage/workspace")>();
  return {
    ...real,
    workspaceHasFile: async (p: string) => files.has(p),
    writeWorkspaceFile: async (p: string, c: string) => {
      files.set(p, c);
    },
  };
});

import {
  createSampleWorkspace,
  sampleWorkspaceFiles,
  SAMPLE_ROOT,
} from "../storage/sampleWorkspace";
import { extractFrontmatter } from "../renderer/pipeline";
import { parseDatabaseSpec } from "../views/database";

beforeEach(() => files.clear());

describe("sample workspace content", () => {
  const sample = sampleWorkspaceFiles();
  const all = sample.map((f) => f.content).join("\n");

  it("ships 5–7 notes", () => {
    expect(sample.length).toBeGreaterThanOrEqual(5);
    expect(sample.length).toBeLessThanOrEqual(7);
  });

  it("showcases every advertised feature", () => {
    expect(all).toMatch(/\[\[[^\]]+\]\]/); // wiki-links
    expect(all).toMatch(/^tags: \[/m); // tags
    expect(all).toContain("```database"); // database view
    expect(all).toContain("```csv"); // CSV table
    expect(all).toContain("```chart"); // chart
    expect(all).toContain("```mermaid"); // diagram
    expect(all).toMatch(/^- \[[ x]\] /m); // task list
    expect(sample.some((f) => /type: template/.test(f.content))).toBe(true); // template
  });

  it("every [[wiki-link]] resolves to a note in the sample", () => {
    const names = new Set(
      sample.map((f) => f.path.split("/").pop()!.replace(/\.md$/, "").toLowerCase()),
    );
    const targets = [...all.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((m) =>
      m[1].trim().toLowerCase(),
    );
    expect(targets.length).toBeGreaterThan(5);
    for (const t of targets) expect(names, `[[${t}]]`).toContain(t);
  });

  it("every note has parseable frontmatter with tags", () => {
    for (const f of sample) {
      const fm = extractFrontmatter(f.content);
      expect(fm, f.path).not.toBeNull();
      expect(Array.isArray(fm!.tags), f.path).toBe(true);
    }
  });

  it("database blocks point at the sample's own project notes", () => {
    const board = sample.find((f) => f.path === "Project Board.md")!;
    const specs = [...board.content.matchAll(/```database\n([\s\S]*?)```/g)].map(
      (m) => parseDatabaseSpec(m[1]).spec!,
    );
    expect(specs.length).toBe(2);
    const projects = sample.filter((f) => f.path.startsWith("Projects/"));
    expect(projects.length).toBeGreaterThanOrEqual(2);
    for (const spec of specs) {
      expect(spec.source).toBe(`${SAMPLE_ROOT}/Projects`);
      for (const p of projects) expect(extractFrontmatter(p.content)!.type).toBe(spec.type);
    }
  });
});

describe("createSampleWorkspace", () => {
  it("writes every note under the sample root and returns the entry note", async () => {
    const res = await createSampleWorkspace();
    expect(res.created.length).toBe(sampleWorkspaceFiles().length);
    expect(res.skipped).toEqual([]);
    expect(res.entry).toBe(`${SAMPLE_ROOT}/Start Here.md`);
    expect(files.has(res.entry)).toBe(true);
    for (const p of files.keys()) expect(p.startsWith(`${SAMPLE_ROOT}/`)).toBe(true);
  });

  it("never overwrites existing files and is idempotent", async () => {
    const mine = `${SAMPLE_ROOT}/Metrics.md`;
    files.set(mine, "# my own edits");
    files.set("Unrelated.md", "keep me");
    const first = await createSampleWorkspace();
    expect(first.skipped).toEqual([mine]);
    expect(files.get(mine)).toBe("# my own edits");
    expect(files.get("Unrelated.md")).toBe("keep me");

    const second = await createSampleWorkspace();
    expect(second.created).toEqual([]);
    expect(second.skipped.length).toBe(sampleWorkspaceFiles().length);
  });
});

describe("sample workspace i18n", () => {
  const KEYS = [
    "cmd.file.openSampleWorkspace",
    "cmd.file.openSampleWorkspace.hint",
    "sample.toast.created",
    "sample.toast.exists",
    "sample.alert.failed",
  ];
  const dir = join(__dirname, "..", "i18n", "locales");
  for (const loc of ["he", "ar", "ru", "fr", "de", "ja", "zh-CN"]) {
    it(`${loc} has real (non-English) translations`, async () => {
      const { t, applyLocale } = await import("../i18n");
      const bundle = readLocale(loc, dir);
      applyLocale("en");
      for (const k of KEYS) {
        expect(typeof bundle[k], `${loc}:${k}`).toBe("string");
        expect(bundle[k], `${loc}:${k}`).not.toBe(t(k));
      }
    });
  }
});
