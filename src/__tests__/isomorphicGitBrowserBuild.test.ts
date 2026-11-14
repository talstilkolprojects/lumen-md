// @vitest-environment node
/**
 * isomorphic-git ≥ 1.37 maps its bare "." export only to index.cjs, the Node
 * build, which hashes packfiles with require("crypto").createHash. In the
 * browser `crypto` is an empty shim, so every clone and pull failed with
 * "createHash is not a function" when GitPackIndex verified the packfile
 * (plan 3.7, found by the G3 data-safety e2e).
 *
 * vite.config.ts aliases the bare import to index.js, the package's own
 * ESM/browser build. This test resolves the import the way the app's client
 * build does (the repo's own vite.config.ts, client environment) and checks
 * that the module it gets cannot reach Node's crypto.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
let server: ViteDevServer;

beforeAll(async () => {
  server = await createServer({
    root,
    configFile: path.join(root, "vite.config.ts"),
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    // The dev server pre-bundles the git modules (#269, vite.config.ts optimizeDeps.include), and
    // config merging adds that list to ours. The production build never pre-bundles, so the list
    // is emptied here: what is checked is the alias the client build resolves through.
    plugins: [
      {
        name: "test:no-prebundle",
        config(c) {
          if (c.optimizeDeps) c.optimizeDeps.include = [];
        },
      },
    ],
    logLevel: "silent",
  });
}, 60_000);

afterAll(async () => {
  await server?.close();
});

async function resolveForBrowser(spec: string): Promise<string> {
  const r = await server.environments.client.pluginContainer.resolveId(spec, path.join(root, "src/sync/git.ts"));
  expect(r, `${spec} resolves in the client environment`).toBeTruthy();
  return r!.id.split("?")[0];
}

describe("isomorphic-git in the browser build", () => {
  it("the bare import resolves to the ESM/browser build, not index.cjs", async () => {
    const id = await resolveForBrowser("isomorphic-git");
    expect(path.basename(id)).toBe("index.js");
    expect(path.basename(path.dirname(id))).toBe("isomorphic-git");
  });

  it("the module the browser gets never reaches Node's crypto.createHash", async () => {
    const src = readFileSync(await resolveForBrowser("isomorphic-git"), "utf8");
    expect(src).not.toMatch(/require\(\s*['"]crypto['"]\s*\)/);
    expect(src).not.toMatch(/from\s+['"](node:)?crypto['"]/);
    expect(src).not.toMatch(/\.createHash\(/);
  });

  it("subpath imports (http/web) still resolve normally", async () => {
    const id = await resolveForBrowser("isomorphic-git/http/web");
    expect(id).toMatch(/isomorphic-git[\\/]http[\\/]web[\\/]/);
  });
});
