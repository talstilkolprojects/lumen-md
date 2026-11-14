/**
 * Plan W7.1 — the `lumen-skills` pack (packages/lumen-skills, MIT): every
 * SKILL.md is a valid Agent Skill whose name is its folder, and every
 * example .base it teaches opens in Lumen's Bases engine without an error.
 * (The live check — Claude Code with the pack writes a .base that opens in
 * Lumen in 10/10 tries — is an owner step; see the PR.)
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseSkill } from "../agents/skills/skillFile";
import { basesFileFromText, parseBase, runBase } from "../views/bases/base";

const ROOT = join(__dirname, "../../packages/lumen-skills");
const skills = readdirSync(join(ROOT, "skills"));

describe("lumen-skills", () => {
  it("has the five skills, MIT, each a valid SKILL.md named after its folder", () => {
    expect(skills.sort()).toEqual(["lumen-bases", "lumen-frontmatter", "lumen-israeli-citation", "lumen-niqqud", "lumen-sefaria-refs"]);
    expect(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).license).toBe("MIT");
    expect(readFileSync(join(ROOT, "LICENSE"), "utf8")).toContain("MIT License");
    for (const dir of skills) {
      const p = parseSkill(readFileSync(join(ROOT, "skills", dir, "SKILL.md"), "utf8"), { kind: "plugin", plugin: "lumen-skills", path: dir }, dir);
      expect(p.ok ? "ok" : `${dir}: ${p.error}`).toBe("ok");
      if (p.ok) {
        expect(p.warnings).toEqual([]);
        expect(p.skill.license).toBe("MIT");
        expect(p.skill.description.length).toBeGreaterThan(60);
      }
    }
  });

  it("every example .base parses and runs in Lumen's engine with no errors", () => {
    const dir = join(ROOT, "skills/lumen-bases/examples");
    expect(existsSync(dir)).toBe(true);
    const notes = [
      basesFileFromText("Tasks/a.md", "---\nstatus: todo\npriority: 2\n---\n# a\n"),
      basesFileFromText("Tasks/b.md", "---\nstatus: done\npriority: 1\n---\n# b\n"),
      basesFileFromText("Reading/book.md", "---\ntags: [book]\nauthor: עמוס עוז\nyear: 2002\nrating: 5\n---\n# סיפור על אהבה וחושך\n"),
    ];
    const files = readdirSync(dir).filter((f) => f.endsWith(".base"));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) {
      const p = parseBase(readFileSync(join(dir, f), "utf8"));
      expect(p.ok ? "ok" : `${f}: ${p.error}`).toBe("ok");
      if (!p.ok) continue;
      for (let v = 0; v < p.base.views.length; v++) {
        const r = runBase(p.base, notes, { view: v });
        expect(r.errors, `${f} view ${v}`).toEqual([]);
        expect(r.total).toBeGreaterThan(0);
      }
    }
  });

  it("every function the bases skill names is one Lumen's engine knows", () => {
    const exprs = ['file.inFolder("Tasks")', 'file.hasTag("book")', 'file.hasLink("x")', "today()", "now()", 'date("2026-01-31")', 'if(priority > 1, "hi", "lo")', 'link("Note")', 'status.lower()', 'status.contains("o")', 'status.startsWith("t")', 'file.tags.contains("book")'];
    const src = `formulas:\n${exprs.map((e, i) => `  f${i}: '${e.replace(/'/g, "''")}'`).join("\n")}\nviews:\n  - type: table\n    name: T\n    order: [${exprs.map((_, i) => `formula.f${i}`).join(", ")}]\n`;
    const p = parseBase(src);
    expect(p.ok ? "ok" : p.error).toBe("ok");
    if (!p.ok) return;
    const r = runBase(p.base, [basesFileFromText("Tasks/a.md", "---\nstatus: todo\npriority: 2\ntags: [book]\n---\n[[x]]\n")]);
    expect(r.errors).toEqual([]);
    const cells = r.rows[0]!.cells;
    for (let i = 0; i < exprs.length; i++) {
      const v = cells[`formula.f${i}`];
      expect(v, exprs[i]).not.toBeUndefined();
      expect(JSON.stringify(v ?? null).toLowerCase(), exprs[i]).not.toContain("error");
    }
  });
});
