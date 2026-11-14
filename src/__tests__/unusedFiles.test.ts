// @vitest-environment node
/**
 * Plan 0.16 — the unused-file gate (scripts/check-unused-files.mjs): a new
 * production file that nothing imports fails CI; the baseline only shrinks.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  findOrphans,
  compare,
  extractSpecifiers,
  htmlEntries,
  globToRegExp,
  resolveSpecifier,
  isProduction,
  isEntryFile,
  BASELINE,
  // @ts-expect-error — plain .mjs script without type declarations
} from "../../scripts/check-unused-files.mjs";

const ROOT = resolve(__dirname, "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "lumen-unused-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function repo(name: string, files: Record<string, string>): string {
  const dir = join(tmp, name);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

describe("findOrphans", () => {
  it("a file nobody imports is an orphan; everything reachable from the page is not", () => {
    const dir = repo("basic", {
      "index.html": '<script type="module" src="/src/main.tsx"></script>',
      "src/main.tsx": 'import { a } from "./a";\nimport "@/styles/boot";\nconst B = lazy(() => import("./lazy/B"));\n',
      "src/a.ts": "export const a = 1;\n",
      "src/styles/boot.ts": "export {};\n",
      "src/lazy/B.tsx": 'export { w } from "../w";\n',
      "src/w.ts": 'export const w = new Worker(new URL("./x.worker.ts", import.meta.url));\n',
      "src/x.worker.ts": "self.onmessage = () => {};\n",
      "src/orphan.ts": "export const nobody = 1;\n",
    });
    expect(findOrphans({ root: dir }).orphans).toEqual(["src/orphan.ts"]);
  });

  it("tests, e2e and scripts are entry points; their imports count as used", () => {
    const dir = repo("tests", {
      "src/__tests__/a.test.ts": 'import { a } from "../a";\n',
      "src/a.ts": "export const a = 1;\n",
      "e2e/x.spec.ts": 'import { b } from "../src/b";\n',
      "src/b.ts": "export const b = 1;\n",
      "src/c.ts": "export const c = 1;\n",
    });
    expect(findOrphans({ root: dir }).orphans).toEqual(["src/c.ts"]);
  });

  it("executables and packages outside src/ are roots too (bin/, api-server/, packages/ …)", () => {
    const dir = repo("roots", {
      "bin/lumen.ts": 'import { cli } from "../src/cli/run";\n',
      "api-server/server.ts": 'import { api } from "../src/api/handler";\n',
      "packages/vscode/src/extension.ts": 'import { x } from "../../../src/shared/x";\n',
      "src/cli/run.ts": "export const cli = 1;\n",
      "src/api/handler.ts": "export const api = 1;\n",
      "src/shared/x.ts": "export const x = 1;\n",
      "src/dead.ts": "export const dead = 1;\n",
    });
    expect(findOrphans({ root: dir }).orphans).toEqual(["src/dead.ts"]);
    expect(isEntryFile("bin/lumen.ts")).toBe(true);
    expect(isEntryFile("src/a.ts")).toBe(false);
    expect(isEntryFile("src/__tests__/a.test.ts")).toBe(true);
  });

  it("import.meta.glob marks every match as used", () => {
    const dir = repo("glob", {
      "index.html": '<script type="module" src="/src/main.ts"></script>',
      "src/main.ts": 'const m = import.meta.glob("./langs/*.ts");\n',
      "src/langs/he.ts": "export {};\n",
      "src/langs/en.ts": "export {};\n",
    });
    expect(findOrphans({ root: dir }).orphans).toEqual([]);
  });

  it("a negative import.meta.glob pattern excludes its file, which is then an orphan (Codex P2, #266)", () => {
    const dir = repo("glob-neg", {
      "index.html": '<script type="module" src="/src/main.ts"></script>',
      "src/main.ts": 'const m = import.meta.glob(["./features/*.ts", "!./features/dead.ts"]);\n',
      "src/features/live.ts": "export {};\n",
      "src/features/dead.ts": "export {};\n",
    });
    expect(findOrphans({ root: dir }).orphans).toEqual(["src/features/dead.ts"]);
    const { globs } = extractSpecifiers('import.meta.glob(["./a/*.ts", "!./a/x.ts"]); import.meta.glob("./b/*.ts");');
    expect(globs).toEqual([["./a/*.ts", "!./a/x.ts"], ["./b/*.ts"]]);
  });
});

describe("the parts", () => {
  it("extracts every kind of specifier", () => {
    const { specs, globs } = extractSpecifiers(
      [
        'import a from "./a";',
        "export * from './b';",
        'import "./c.css";',
        'await import("./d");',
        'require("./e");',
        'vi.mock("./f");',
        'new Worker(new URL("./g.worker.ts", import.meta.url));',
        'import.meta.glob(["./h/*.ts", "./i/**/*.ts"]);',
      ].join("\n"),
    );
    expect(specs).toEqual(["./a", "./b", "./c.css", "./d", "./e", "./f", "./g.worker.ts"]);
    expect(globs).toEqual([["./h/*.ts", "./i/**/*.ts"]]);
  });

  it("resolves relative, alias, extensionless, .js-for-.ts, index and ?worker specifiers", () => {
    const files = new Set(["src/a.ts", "src/b/index.tsx", "src/c.ts", "src/d.worker.ts"]);
    expect(resolveSpecifier("./a", "src/x.ts", files)).toBe("src/a.ts");
    expect(resolveSpecifier("@/b", "src/deep/x.ts", files)).toBe("src/b/index.tsx");
    expect(resolveSpecifier("../c.js", "src/deep/x.ts", files)).toBe("src/c.ts");
    expect(resolveSpecifier("./d.worker.ts?worker", "src/x.ts", files)).toBe("src/d.worker.ts");
    expect(resolveSpecifier("react", "src/x.ts", files)).toBeNull();
  });

  it("reads module scripts from HTML, skipping remote ones", () => {
    expect(htmlEntries('<script src="/theme-boot.js"></script><script type="module" src="/src/main.tsx"></script><script src="https://x.y/z.js"></script>')).toEqual([
      "theme-boot.js",
      "src/main.tsx",
    ]);
  });

  it("globs: * stays in one folder, ** crosses folders", () => {
    expect(globToRegExp("src/a/*.ts").test("src/a/b.ts")).toBe(true);
    expect(globToRegExp("src/a/*.ts").test("src/a/x/b.ts")).toBe(false);
    expect(globToRegExp("src/**/*.ts").test("src/a/x/b.ts")).toBe(true);
    expect(globToRegExp("src/*.{ts,tsx}").test("src/b.tsx")).toBe(true);
  });

  it("tests, eval suites and declarations are not production files", () => {
    expect(isProduction("src/a.ts")).toBe(true);
    for (const f of ["src/__tests__/a.ts", "src/a.test.ts", "src/a.spec.tsx", "src/agents/eval/x.eval.ts", "src/types.d.ts", "scripts/a.mjs"]) {
      expect(isProduction(f)).toBe(false);
    }
  });
});

describe("the gate", () => {
  it("a new orphan fails; a baseline entry that is used again must be pruned", () => {
    expect(compare(["src/old.ts", "src/new.ts"], ["src/old.ts"])).toEqual({ added: ["src/new.ts"], stale: [] });
    expect(compare([], ["src/old.ts"])).toEqual({ added: [], stale: ["src/old.ts"] });
  });

  it("the checked-in tree matches the baseline exactly", () => {
    const baseline: string[] = JSON.parse(readFileSync(join(ROOT, BASELINE), "utf8")).files;
    expect(compare(findOrphans({ root: ROOT }).orphans, baseline)).toEqual({ added: [], stale: [] });
  });
});
