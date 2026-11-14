/**
 * W10.D12 acceptance: 0 direct imports of src/sync/e2ee/primitives/*.ts outside
 * the interface (primitives/index.ts), so the implementation is chosen in one
 * place. Inside primitives/ the files may import each other (argon2 uses
 * blake2b); one test file tests poly1305, which is no primitive of the
 * interface, in its in-house file. W10.D13: the library-backed code is outside
 * tsconfig and ESLint until the Mac run, and nothing in the app imports it.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FILES = ["argon2", "blake2b", "chacha20poly1305", "scrypt"];
const ALLOWED = new Set(["src/__tests__/e2eeAge.test.ts"]); // poly1305 alone

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (n === "node_modules") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(m?[jt]sx?)$/.test(n)) out.push(p);
  }
  return out;
}

describe("one door to the crypto primitives", () => {
  const files = [...walk("src"), ...walk("scripts")];
  const direct = new RegExp(`from\\s+["'][^"']*primitives/(${FILES.join("|")})["']|import\\(\\s*["'][^"']*primitives/(${FILES.join("|")})["']`);

  it("no file outside primitives/ imports an implementation file directly", () => {
    const offenders = files.filter((f) => !f.startsWith("src/sync/e2ee/primitives/") && !ALLOWED.has(f) && direct.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the callers go through the interface", () => {
    expect(readFileSync("src/sync/e2ee/kdf.ts", "utf8")).toMatch(/from "\.\/primitives";/);
    expect(readFileSync("src/sync/e2ee/age.ts", "utf8")).toMatch(/import \{ chachaOpen, chachaSeal, scrypt \} from "\.\/primitives";/);
  });

  it("the audited implementation is outside tsconfig and ESLint, and only tests import it, until 10.M", () => {
    expect(JSON.parse(readFileSync("tsconfig.json", "utf8")).exclude).toContain("src/sync/e2ee/primitives/lib");
    expect(readFileSync("eslint.config.js", "utf8")).toContain('"src/sync/e2ee/primitives/lib/**"');
    const users = files.filter((f) => !f.startsWith("src/sync/e2ee/primitives/lib/") && /primitives\/lib\//.test(readFileSync(f, "utf8")));
    expect(users.every((f) => f.startsWith("src/__tests__/"))).toBe(true);
    // Not noble's argon2 (outside its audit): hash-wasm, with libsodium as the fallback.
    const lib = readFileSync("src/sync/e2ee/primitives/lib/argon2.ts", "utf8");
    expect(lib).toMatch(/import\("hash-wasm"\)/);
    expect(lib).toMatch(/import\("libsodium-wrappers-sumo"\)/);
    expect(readFileSync("src/sync/e2ee/primitives/lib/audited.ts", "utf8")).not.toMatch(/@noble\/hashes\/argon2/);
  });
});
