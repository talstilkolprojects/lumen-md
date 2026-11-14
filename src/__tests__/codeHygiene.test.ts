import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs script without type declarations
import { checkFiles, DIRECT_FS_ALLOWLIST, findViolations, productionFiles } from "../../scripts/check-code-hygiene.mjs";

type Violation = { line: number; rule: string; text: string };
const check = (src: string, name = "x.ts"): Violation[] => findViolations(name, src);

describe("scripts/check-code-hygiene", () => {
  it("flags `as any` casts and console.log calls", () => {
    const v = check(`const a = b as any;\nconsole.log("hi");\n`);
    expect(v.map((x) => x.rule)).toEqual(["as-any", "console-log"]);
    expect(v.map((x) => x.line)).toEqual([1, 2]);
  });

  it("ignores strings, template literals, comments and other console methods", () => {
    const v = check(
      [
        `const s = 'console.log("x") as any';`,
        "const t = `console.log(1)`;",
        "// console.log(nope) as any",
        "console.info('ok'); console.warn('ok');",
      ].join("\n"),
    );
    expect(v).toEqual([]);
  });

  it("honours a justified hygiene-allow comment", () => {
    expect(check(`// hygiene-allow: dev sink\nconsole.log(1);`)).toEqual([]);
    expect(check(`console.log(1); // hygiene-allow: reason`)).toEqual([]);
    // A bare marker without justification does not count.
    expect(check(`// hygiene-allow:\nconsole.log(1);`)).toHaveLength(1);
  });

  it("parses TSX", () => {
    expect(check(`const el = <div>{(x as any).y}</div>;`, "c.tsx")).toHaveLength(1);
  });

  describe("direct file-system access (plan 4.1: one vault layer)", () => {
    const fs = (src: string) => check(src).filter((v) => v.rule === "direct-fs");

    it("flags OPFS / File System Access handle calls", () => {
      const v = fs(
        [
          "const root = await navigator.storage.getDirectory();",
          "const r2 = await window.navigator.storage?.getDirectory();",
          "const d = await root.getDirectoryHandle('notes', { create: true });",
          "const f = await d.getFileHandle('a.md');",
          "const w = await f.createWritable();",
          "const s = await f.createSyncAccessHandle();",
          "await d.removeEntry('a.md');",
          "const w2 = await f['createWritable']();",
        ].join("\n"),
      );
      expect(v.map((x) => x.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it("flags the calls inside a worker's source string, too", () => {
      expect(fs("const W = `self.onmessage = async () => { const d = await navigator.storage.getDirectory(); }`;")).toHaveLength(1);
      expect(fs(`const W = "var f = await dir.getFileHandle(n, { create: true });";`)).toHaveLength(1);
      expect(fs("const W = `a ${x} b.createWritable() c`;")).toHaveLength(1);
    });

    it("ignores feature checks, comments, other getDirectory methods and plain mentions", () => {
      const v = fs(
        [
          "const ok = typeof h.createWritable === 'function' && 'createWritable' in h;",
          "const has = !!navigator.storage?.getDirectory;",
          "// await navigator.storage.getDirectory()",
          "const z = zip.getDirectory();",
          "const label = 'getFileHandle is a method';",
        ].join("\n"),
      );
      expect(v).toEqual([]);
    });

    it("a hygiene-allow comment does not exempt it: only the allowlist does", () => {
      expect(fs("// hygiene-allow: just this once\nawait navigator.storage.getDirectory();")).toHaveLength(1);
    });

    it("every allowlist entry says why", () => {
      for (const [file, reason] of Object.entries(DIRECT_FS_ALLOWLIST as Record<string, string>)) {
        expect(file).toMatch(/^src\//);
        expect(reason.length).toBeGreaterThan(20);
      }
    });

    it("the real source tree: no direct access outside the vault layer and the allowlist, no stale entries", () => {
      const { violations, stale } = checkFiles(productionFiles(), { onlyDirectFs: true });
      expect(violations).toEqual([]);
      expect(stale).toEqual([]);
    });
  });
});
