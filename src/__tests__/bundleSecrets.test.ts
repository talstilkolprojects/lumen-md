/**
 * Plan 3.6.2: no collab server secret in the web app. The collab client
 * reads no build-time token, src never imports the server, and the bundle
 * scanner (run by CI on the real build, with canary values set) finds
 * planted secrets and server code.
 * @vitest-environment node
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// @ts-expect-error -- plain ESM script module, no types
import { scanForSecrets } from "../../scripts/lib/bundleSecrets.mjs";

const ROOT = resolve(__dirname, "../..");
const SRC = join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "__tests__") walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("collab secrets stay out of the app", () => {
  const sources = walk(SRC).map((file) => ({ file, text: readFileSync(file, "utf8") }));

  it("the collab client reads no build-time token or secret", () => {
    const collab = sources.filter(({ file }) => /[\\/](collab[\\/]|hooks[\\/]useCollab|ui[\\/]CollabSettings)/.test(file));
    expect(collab.length).toBeGreaterThan(3);
    for (const { file, text } of collab) {
      expect(text, file).not.toMatch(/VITE_[A-Z0-9_]*(TOKEN|SECRET|ACCESS_KEY)/);
    }
  });

  it("nothing in src imports the collab server", () => {
    for (const { file, text } of sources) expect(text, file).not.toMatch(/from\s+["'][./]*sync-server\//);
  });

  it("the scanner finds a planted secret value and server code, and passes a clean bundle", () => {
    const dir = mkdtempSync(join(tmpdir(), "lumen-bundle-"));
    tmp.push(dir);
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "index.js"), "console.log('clean')");
    const env = { COLLAB_TOKEN_SECRET: "canary-secret-0123456789abcdef0123456789", COLLAB_ACCESS_KEY: "canary-access-key" };
    expect(scanForSecrets(dir, env).findings).toEqual([]);
    writeFileSync(join(dir, "assets", "leak.js"), `const k="${env.COLLAB_ACCESS_KEY}";`);
    writeFileSync(join(dir, "assets", "server.js"), "db.exec(`VACUUM INTO 'x'`)");
    const { findings } = scanForSecrets(dir, env);
    expect(findings).toEqual(
      expect.arrayContaining([
        { file: join("assets", "leak.js"), what: "value of COLLAB_ACCESS_KEY" },
        { file: join("assets", "server.js"), what: 'server code marker "VACUUM INTO"' },
      ]),
    );
  });

  // When a build is present locally, check it too (CI runs the script on its own build).
  it.skipIf(!existsSync(join(ROOT, "dist")))("the built bundle in dist/ has no collab server code", () => {
    expect(scanForSecrets(join(ROOT, "dist"), {}).findings).toEqual([]);
  });
});
