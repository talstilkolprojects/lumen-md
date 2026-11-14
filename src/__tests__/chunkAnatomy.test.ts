/** W1.36 — what a chunk is made of: packages by esbuild's module marks, duplicates, inline blobs. */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
// @ts-expect-error — plain .mjs helper without types
import { anatomy, inlineBlobs, moduleRegions, packageOf, reportLines } from "../../scripts/lib/chunkAnatomy.mjs";

const ROOT = resolve(__dirname, "..", "..");

type Pkg = { name: string; kb: number; gzipKb: number; share: number; modules: number; installs: string[] };
type Blob = { kind: string; mime: string; bytes: number; decodedBytes: number };

/** A wasm module header ("\0asm", version 1) followed by pseudo-random bytes, as base64. */
function wasmBase64(bytes: number): string {
  const b = Buffer.alloc(bytes);
  b.set([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  let x = 7;
  for (let i = 8; i < bytes; i++) b[i] = (x = (x * 1103515245 + 12345) & 0x7fffffff) >> 16;
  return b.toString("base64");
}

const body = (name: string, n: number) => Array.from({ length: n }, (_, i) => `var ${name}_${i} = function(a) { return a + ${i}; };`).join("\n");

/** What esbuild leaves in an unminified bundle: one `// path` line per inlined module. */
const DEV_CHUNK = [
  "import { a } from './chunk-OTHER.js';",
  "// ../../node_modules/roughjs/bin/rough.js",
  body("rough", 300),
  "// ../../node_modules/roughjs/bin/canvas.js",
  body("canvas", 100),
  "// ../../node_modules/@excalidraw/laser-pointer/dist/esm.js",
  body("laser", 40),
  "// ../../node_modules/pako/dist/pako.esm.mjs",
  body("pako", 80),
  "// ../../node_modules/some-dep/node_modules/pako/dist/pako.esm.mjs",
  body("pako2", 80),
  "// element/src/shapes.ts",
  body("own", 60),
  `var wasm = "${wasmBase64(9000)}";`,
].join("\n");

describe("chunk anatomy (W1.36)", () => {
  it("names the package of a module path, scoped or not, nested or not", () => {
    expect(packageOf("../../node_modules/roughjs/bin/rough.js")).toBe("roughjs");
    expect(packageOf("node_modules/@excalidraw/laser-pointer/dist/esm.js")).toBe("@excalidraw/laser-pointer");
    expect(packageOf("node_modules/a/node_modules/pako/index.js")).toBe("pako");
    expect(packageOf("element/src/shapes.ts")).toBe("");
  });

  it("splits an esbuild dev chunk at its module marks, and finds none in a minified one", () => {
    const regions = moduleRegions(DEV_CHUNK) as Array<{ path: string; bytes: number }>;
    expect(regions.map((r) => r.path)).toEqual([
      "",
      "../../node_modules/roughjs/bin/rough.js",
      "../../node_modules/roughjs/bin/canvas.js",
      "../../node_modules/@excalidraw/laser-pointer/dist/esm.js",
      "../../node_modules/pako/dist/pako.esm.mjs",
      "../../node_modules/some-dep/node_modules/pako/dist/pako.esm.mjs",
      "element/src/shapes.ts",
    ]);
    // Every byte belongs to exactly one region (+1 for the final line, which has no newline).
    expect(regions.reduce((n, r) => n + r.bytes, 0)).toBe(Buffer.byteLength(DEV_CHUNK) + 1);
    expect(moduleRegions('var a=1;// not a mark\nvar b="// x.js";')).toEqual([]);
  });

  it("ranks packages by size and flags a package inlined from two installs", () => {
    const a = anatomy(DEV_CHUNK);
    const names = (a.packages as Pkg[]).map((p) => p.name);
    expect(names[0]).toBe("roughjs");
    expect(names).toContain("@excalidraw/laser-pointer");
    expect(names).toContain("(own code)");
    const rough = (a.packages as Pkg[]).find((p) => p.name === "roughjs")!;
    expect(rough.modules).toBe(2);
    expect(rough.installs).toEqual(["node_modules/roughjs"]);
    expect(a.duplicates).toEqual([{ name: "pako", installs: ["node_modules/pako", "node_modules/some-dep/node_modules/pako"] }]);
    expect(a.marked).toBe(true);
    expect(a.gzipKb).toBeGreaterThan(0);
    expect(a.gzipKb).toBeLessThan(a.kb);
  });

  it("finds an embedded wasm as a base64 run and as a data: URI, and ignores short or non-base64 text", () => {
    const b64 = wasmBase64(9000);
    const blobs = inlineBlobs(`x="${b64}";y="data:application/wasm;base64,${b64}";`) as Blob[];
    expect(blobs.map((b) => [b.kind, b.mime])).toEqual([
      ["data-uri", "application/wasm"],
      ["base64", "application/wasm"],
    ]);
    expect(blobs[1].decodedBytes).toBeGreaterThanOrEqual(8999);
    expect(inlineBlobs(`a="${wasmBase64(600)}"`)).toEqual([]);
    expect(inlineBlobs(`a="${"abcdefghij".repeat(1000)}"`)).toEqual([]);
    expect((anatomy(DEV_CHUNK).blobs as Blob[]).map((b) => b.mime)).toEqual(["application/wasm"]);
  });

  it("reports a minified chunk without marks, pointing at dist/dev", () => {
    const lines = reportLines("x.js", anatomy("var a=1;function b(){return a}export{b};")) as string[];
    expect(lines[0]).toMatch(/^x\.js: [\d.]+ KB raw, [\d.]+ KB gzip$/);
    expect(lines.join("\n")).toMatch(/dist\/dev/);
    expect(lines.join("\n")).toMatch(/inline blobs: none/);
  });

  it("the CLI prints usage and exits 2 without a file", () => {
    const r = spawnSync(process.execPath, [resolve(ROOT, "scripts", "chunk-anatomy.mjs")], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage: node scripts\/chunk-anatomy\.mjs/);
  });
});
