/**
 * The download manifest of webR, the R runtime of ```live-r blocks (plan
 * W1.34).
 *
 * webR's binaries (R, libgfortran) are GPL-3.0 (its LICENSE.md), so Lumen's
 * build does not ship them: the R block offers the download, with the
 * licence first, and the app fetches the files from the npm package's own
 * CDN copy (src/plugins/r/webrInstall.ts). This manifest is what makes that
 * download trustworthy: it lists every file of the webR version this build
 * was made with, with its size and SHA-256, read from node_modules/webr/dist
 * at build time (webR is a devDependency, for exactly this and its types).
 * A downloaded file that does not match is refused.
 *
 * The manifest is the app's own data (no webR code in it), emitted as
 * `runtimes/webr.json` and served in dev by the same plugin.
 *
 * This module is build tooling: it is imported by vite.config.ts and tests,
 * never by the app bundle.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

/** Where the manifest is served, relative to the app's base. */
export const WEBR_MANIFEST_PATH = "runtimes/webr.json";

/** [path under dist/, size in bytes, SHA-256 in base64]. */
export type WebRManifestFile = [path: string, size: number, sha256: string];

export interface WebRManifest {
  /** The webr npm version: the download comes from webr@<version>/dist/. */
  version: string;
  files: WebRManifestFile[];
  bytes: number;
  /** The CSP the eval-workers route gives /webr/ (security/policy.json), for the cached worker script. */
  workerCsp: string;
}

/** The files under `distDir` for `entries` (folders recursively), sorted. */
export function listEntries(distDir: string, entries: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = join(distDir, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs).sort()) walk(`${rel}/${name}`);
      return;
    }
    // Source maps are not served (plan 11.5).
    if (!rel.endsWith(".map")) out.push(rel);
  };
  for (const e of entries) walk(e);
  return out;
}

/** The eval-workers policy of security/policy.json as one header value. */
export function workerCspFrom(policy: { routes: Record<string, { csp: Record<string, string[]> }> }): string {
  const csp = policy.routes["eval-workers"]?.csp;
  if (!csp) throw new Error("security/policy.json has no eval-workers route");
  return Object.entries(csp)
    .map(([name, values]) => (values.length ? `${name} ${values.join(" ")}` : name))
    .join("; ");
}

/** Build the manifest from an installed webr package; null when it is not installed. */
export function buildWebRManifest(root: string): WebRManifest | null {
  const pkgDir = join(root, "node_modules", "webr");
  const distDir = join(pkgDir, "dist");
  if (!existsSync(join(pkgDir, "package.json")) || !existsSync(distDir)) return null;
  const { version } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { version: string };
  const { entries } = JSON.parse(readFileSync(join(root, "src", "plugins", "r", "webrRuntime.json"), "utf8")) as { entries: string[] };
  const files: WebRManifestFile[] = listEntries(distDir, entries).map((rel) => {
    const bytes = readFileSync(join(distDir, rel));
    return [rel, bytes.length, createHash("sha256").update(bytes).digest("base64")];
  });
  const policy = JSON.parse(readFileSync(join(root, "security", "policy.json"), "utf8"));
  return { version, files, bytes: files.reduce((n, f) => n + f[1], 0), workerCsp: workerCspFrom(policy) };
}

/** Emits runtimes/webr.json into the build and serves it in dev. */
export function webrManifestPlugin(root: string): Plugin {
  let cached: string | null | undefined;
  const json = () => {
    if (cached === undefined) {
      const m = buildWebRManifest(root);
      cached = m ? JSON.stringify(m) : null;
    }
    return cached;
  };
  return {
    name: "lumen-webr-manifest",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? "").split("?")[0].replace(/^\//, "") !== WEBR_MANIFEST_PATH) return next();
        const body = json();
        if (!body) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(body);
      });
    },
    generateBundle() {
      const body = json();
      if (!body) {
        this.warn("webr is not installed: no runtimes/webr.json, live R cannot be downloaded from this build");
        return;
      }
      this.emitFile({ type: "asset", fileName: WEBR_MANIFEST_PATH, source: body });
    },
  };
}
