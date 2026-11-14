/**
 * Plan W4.3 step 2 (audit W10.C30): the taken domain is checked in the
 * whole tree, not only in the lines a PR adds. The domain is built from
 * its parts here, so this file never names it either.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain .mjs script without type declarations
import { domainInText, domainInTree } from "../../scripts/lib/takenDomain.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { takenDomainViolations } from "../../scripts/check-code-hygiene.mjs";

const dom = ["lumen", "md"].join(".");
type Hit = { file: string; line: number };
const where = (hits: Hit[]) => hits.map((h) => `${h.file}:${h.line}`);

let tmp: string | null = null;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function tree(files: Record<string, string | Uint8Array>): string {
  const dir = mkdtempSync(join(tmpdir(), "taken-domain-"));
  tmp = dir;
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

describe("the taken domain in the whole tree", () => {
  it("this checkout names it nowhere (0 mentions)", () => {
    expect(where(domainInTree(process.cwd()))).toEqual([]);
  });

  it("a mention already on the branch fails, in index.html, public/, docs/, README or anywhere else", () => {
    const root = tree({
      "index.html": `<link rel="canonical" href="https://lumen-md.vercel.app/">\n<meta property="og:url" content="https://${dom}/">`,
      "public/plugins/CONTEST.md": `# Contest\n\nSubmit at https://www.${dom}/contest\n`,
      "docs/guide.md": `ok\nok\n${dom.toUpperCase()}\n`,
      "README.md": `see https://${dom}`,
      "src/ui/About.tsx": `const site = "https://${dom}";`,
      "public/clean.md": "the file README.md, the folder lumen.mdx, https://lumen-md.vercel.app",
    });
    expect(where(domainInTree(root))).toEqual(["README.md:1", "docs/guide.md:3", "index.html:2", "public/plugins/CONTEST.md:3", "src/ui/About.tsx:1"]);
  });

  it("dependencies, build output, git's data and binary files are not the project's text", () => {
    const bin = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, ...new TextEncoder().encode(dom)]);
    const root = tree({
      "node_modules/x/README.md": dom,
      "dist/index.html": dom,
      ".git/COMMIT_EDITMSG": dom,
      "src-tauri/target/x.txt": dom,
      "public/icon.png": bin,
    });
    expect(domainInTree(root)).toEqual([]);
  });

  it("README.md, lumen.mdx and our own host are not the domain", () => {
    expect(domainInText("README.md\nsrc/lumen.mdx\nhttps://lumen-md.vercel.app\nlumen-md")).toEqual([]);
    expect(domainInText(`a\nhttps://${dom}/x`)).toMatchObject([{ line: 2 }]);
  });

  it("npm run hygiene fails on it (rule taken-domain)", () => {
    const root = tree({ "public/tutorials/index.md": `x\n${dom}\n` });
    expect(takenDomainViolations(root)).toMatchObject([{ file: "public/tutorials/index.md", line: 2, rule: "taken-domain" }]);
    expect(takenDomainViolations(process.cwd())).toEqual([]);
  });
});
