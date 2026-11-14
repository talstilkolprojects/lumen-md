// @vitest-environment node
/**
 * webR as a user-initiated download (plan W1.34): no webR in the build, the
 * download checked file by file against the build's manifest, stored where
 * the service worker serves it, with the worker's preludes and policy.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWebRManifest, listEntries, workerCspFrom } from "../build/webrManifest";
import {
  WEBR_INSTALLED_MARKER,
  WebRInstallError,
  installWebR,
  prepareWebRFile,
  webrAvailable,
  webrCacheName,
  webrHeaders,
  webrSources,
  type WebRManifest,
} from "../plugins/r/webrInstall";
import runtime from "../plugins/r/webrRuntime.json";

const ROOT = resolve(__dirname, "../..");
const enc = new TextEncoder();
const sha = (s: string) => createHash("sha256").update(s).digest("base64");

/** A Cache Storage good enough for put / match / has / delete. */
function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const storage = {
    stores,
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name)!;
      return {
        async put(req: Request, res: Response) {
          m.set(req.url, res);
        },
        async match(url: string) {
          return m.get(url)?.clone();
        },
      };
    },
    async has(name: string) {
      return stores.has(name);
    },
    async delete(name: string) {
      return stores.delete(name);
    },
  };
  return storage as unknown as CacheStorage & { stores: typeof stores };
}

const FILES: Record<string, string> = {
  "webr.js": "export class WebR {}\n//# sourceMappingURL=webr.mjs.map\n",
  "webr-worker.js": "self.onmessage = () => {};\n",
  "R.wasm": "\0asm-bytes",
  "vfs/usr/lib/R/library/base/R/base": "base R",
};
const MANIFEST: WebRManifest = {
  version: "0.6.0",
  files: Object.entries(FILES).map(([p, body]) => [p, enc.encode(body).length, sha(body)]),
  bytes: Object.values(FILES).reduce((n, b) => n + enc.encode(b).length, 0),
  workerCsp: "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'",
};
const CACHE = "lumen-runtime-webr-0.6.0-abcd1234";

/** A fetch that serves `FILES` from the given hosts (others: 404), optionally with tampered bytes. */
function cdnFetch(serve: { host: string; tamper?: boolean }[]) {
  const seen: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    seen.push(url.href);
    const rule = serve.find((s) => s.host === url.host);
    const path = decodeURIComponent(url.pathname.replace(/^\/(v[\d.]+|npm\/webr@[\d.]+\/dist)\//, ""));
    const key = url.host === "webr.r-wasm.org" && path === "webr.mjs" ? "webr.js" : path;
    if (!rule || !(key in FILES)) return new Response("", { status: 404 });
    return new Response(rule.tamper ? FILES[key] + "!" : FILES[key]);
  }) as typeof fetch;
  return { impl, seen };
}

describe("webR download sources", () => {
  it("webR's own CDN first (its browser module is webr.mjs there), then the npm package on jsDelivr", () => {
    const [own, npm] = webrSources("0.6.0");
    expect(own("webr.js")).toBe("https://webr.r-wasm.org/v0.6.0/webr.mjs");
    expect(own("vfs/usr/lib/R/a b")).toBe("https://webr.r-wasm.org/v0.6.0/vfs/usr/lib/R/a%20b");
    expect(npm("webr.js")).toBe("https://cdn.jsdelivr.net/npm/webr@0.6.0/dist/webr.js");
  });

  it("uses the service worker's webr runtime cache", () => {
    expect(webrCacheName(["lumen-runtime-ruby-2", CACHE])).toBe(CACHE);
    expect(webrCacheName([])).toBeNull();
  });
});

describe("prepareWebRFile / webrHeaders", () => {
  it("gives the worker both preludes, once, and drops source-map comments", () => {
    const worker = prepareWebRFile("webr-worker.js", enc.encode("work();\n").buffer as ArrayBuffer) as string;
    expect(worker.startsWith(runtime.trustedTypes + runtime.isolation)).toBe(true);
    expect(worker.endsWith("work();\n")).toBe(true);
    expect(prepareWebRFile("webr-worker.js", enc.encode(worker).buffer as ArrayBuffer)).toBe(worker);
    expect(prepareWebRFile("webr.js", enc.encode(FILES["webr.js"]).buffer as ArrayBuffer)).toBe("export class WebR {}\n");
    const wasm = enc.encode("\0asm").buffer as ArrayBuffer;
    expect(prepareWebRFile("R.wasm", wasm)).toBe(wasm);
  });

  it("serves the worker with the eval-workers policy and every file with its type and nosniff", () => {
    const w = webrHeaders("webr-worker.js", MANIFEST);
    expect(w.get("Content-Security-Policy")).toBe(MANIFEST.workerCsp);
    expect(w.get("Content-Type")).toMatch(/javascript/);
    expect(webrHeaders("R.wasm", MANIFEST).get("Content-Type")).toBe("application/wasm");
    expect(webrHeaders("R.wasm", MANIFEST).get("Content-Security-Policy")).toBeNull();
    expect(webrHeaders("vfs/x", MANIFEST).get("X-Content-Type-Options")).toBe("nosniff");
  });
});

describe("installWebR", () => {
  it("stores every verified file under <base>webr/, the marker last, and reports progress", async () => {
    const caches = fakeCaches();
    const { impl } = cdnFetch([{ host: "webr.r-wasm.org" }]);
    const progress: number[] = [];
    await installWebR({ base: "/", manifest: MANIFEST, fetchImpl: impl, cachesImpl: caches, cacheName: CACHE, onProgress: (d) => progress.push(d) });
    const store = caches.stores.get(CACHE)!;
    const keys = [...store.keys()];
    expect(keys.at(-1)).toBe(`http://localhost/webr/${WEBR_INSTALLED_MARKER}`);
    expect(keys.slice(0, -1).sort()).toEqual(Object.keys(FILES).map((p) => `http://localhost/webr/${p}`).sort());
    const worker = store.get("http://localhost/webr/webr-worker.js")!;
    expect(worker.headers.get("Content-Security-Policy")).toBe(MANIFEST.workerCsp);
    expect((await worker.clone().text()).startsWith("/* Lumen:")).toBe(true);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(MANIFEST.bytes);
    expect(await webrAvailable({ base: "/", cachesImpl: caches, cacheName: CACHE, fetchImpl: (async () => new Response("", { status: 404 })) as typeof fetch })).toBe(true);
  });

  it("falls back to jsDelivr when webR's CDN serves bytes that do not match", async () => {
    const caches = fakeCaches();
    const { impl, seen } = cdnFetch([{ host: "webr.r-wasm.org", tamper: true }, { host: "cdn.jsdelivr.net" }]);
    await installWebR({ base: "/", manifest: MANIFEST, fetchImpl: impl, cachesImpl: caches, cacheName: CACHE, concurrency: 1 });
    expect(seen.filter((u) => u.includes("jsdelivr"))).toHaveLength(Object.keys(FILES).length);
    expect(caches.stores.get(CACHE)!.size).toBe(Object.keys(FILES).length + 1);
  });

  it("installs nothing when no source matches the checksums: the cache is deleted", async () => {
    const caches = fakeCaches();
    const { impl } = cdnFetch([{ host: "webr.r-wasm.org", tamper: true }, { host: "cdn.jsdelivr.net", tamper: true }]);
    const err = await installWebR({ base: "/", manifest: MANIFEST, fetchImpl: impl, cachesImpl: caches, cacheName: CACHE }).catch((e) => e);
    expect(err).toBeInstanceOf(WebRInstallError);
    expect((err as WebRInstallError).code).toBe("mismatch");
    expect(caches.stores.has(CACHE)).toBe(false);
  });

  it("needs the runtime cache (no service worker: nothing is fetched)", async () => {
    const { impl, seen } = cdnFetch([{ host: "webr.r-wasm.org" }]);
    const err = await installWebR({ base: "/", manifest: MANIFEST, fetchImpl: impl, cachesImpl: fakeCaches(), cacheName: null }).catch((e) => e);
    expect((err as WebRInstallError).code).toBe("no-cache");
    expect(seen).toEqual([]);
  });

  it("a cancelled download stops and leaves nothing behind", async () => {
    const caches = fakeCaches();
    const ctrl = new AbortController();
    ctrl.abort();
    const { impl } = cdnFetch([{ host: "webr.r-wasm.org" }]);
    const err = await installWebR({ base: "/", manifest: MANIFEST, fetchImpl: impl, cachesImpl: caches, cacheName: CACHE, signal: ctrl.signal }).catch((e) => e);
    expect((err as WebRInstallError).code).toBe("aborted");
    expect(caches.stores.has(CACHE)).toBe(false);
  });
});

describe("webrAvailable", () => {
  const server = (status: number, type: string) => (async () => new Response("x", { status, headers: { "Content-Type": type } })) as typeof fetch;
  it("is false without a download and without a copy on the server", async () => {
    expect(await webrAvailable({ base: "/", cachesImpl: fakeCaches(), cacheName: CACHE, fetchImpl: server(404, "text/plain") })).toBe(false);
  });
  it("is false when the server answers with the SPA's index.html", async () => {
    expect(await webrAvailable({ base: "/", cachesImpl: fakeCaches(), cacheName: CACHE, fetchImpl: server(200, "text/html") })).toBe(false);
  });
  it("is true for a deployment's own copy (npm run webr:local)", async () => {
    expect(await webrAvailable({ base: "/", cachesImpl: fakeCaches(), cacheName: CACHE, fetchImpl: server(200, "text/javascript") })).toBe(true);
  });
  it("a cache without the marker (an interrupted download) is not an install", async () => {
    const caches = fakeCaches();
    await caches.open(CACHE);
    expect(await webrAvailable({ base: "/", cachesImpl: caches, cacheName: CACHE, fetchImpl: server(404, "text/plain") })).toBe(false);
  });
});

describe("the build's webR manifest (src/build/webrManifest.ts)", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("lists every entry of webrRuntime.json with its size and SHA-256, without source maps", () => {
    dir = mkdtempSync(join(tmpdir(), "webr-manifest-"));
    const dist = join(dir, "node_modules", "webr", "dist");
    mkdirSync(join(dist, "vfs", "lib"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "webr", "package.json"), JSON.stringify({ name: "webr", version: "0.6.0" }));
    writeFileSync(join(dist, "webr.js"), "module");
    writeFileSync(join(dist, "webr.mjs"), "node build: not served");
    writeFileSync(join(dist, "webr-worker.js"), "worker");
    writeFileSync(join(dist, "webr-worker.js.map"), "{}");
    writeFileSync(join(dist, "R.wasm"), "wasm");
    writeFileSync(join(dist, "vfs", "lib", "a"), "a");
    mkdirSync(join(dir, "src", "plugins", "r"), { recursive: true });
    writeFileSync(join(dir, "src", "plugins", "r", "webrRuntime.json"), readFileSync(join(ROOT, "src/plugins/r/webrRuntime.json")));
    mkdirSync(join(dir, "security"));
    writeFileSync(join(dir, "security", "policy.json"), readFileSync(join(ROOT, "security/policy.json")));
    const m = buildWebRManifest(dir)!;
    expect(m.version).toBe("0.6.0");
    expect(m.files.map((f) => f[0])).toEqual(["webr.js", "webr-worker.js", "R.wasm", "vfs/lib/a"]);
    expect(m.files[0]).toEqual(["webr.js", 6, sha("module")]);
    expect(m.bytes).toBe(6 + 6 + 4 + 1);
    expect(m.workerCsp).toContain("'unsafe-eval'");
    expect(listEntries(dist, ["missing"])).toEqual([]);
  });

  it("is null when webr is not installed (the build then warns and ships no download)", () => {
    dir = mkdtempSync(join(tmpdir(), "webr-manifest-"));
    expect(buildWebRManifest(dir)).toBeNull();
  });

  it("gives the cached worker the policy security/policy.json gives /webr/", () => {
    const policy = JSON.parse(readFileSync(join(ROOT, "security/policy.json"), "utf8"));
    expect(policy.routes["eval-workers"].samples).toContain("/webr/webr-worker.js");
    expect(workerCspFrom(policy)).toBe(
      Object.entries(policy.routes["eval-workers"].csp as Record<string, string[]>)
        .map(([k, v]) => `${k} ${v.join(" ")}`)
        .join("; "),
    );
  });
});

describe("no webR in Lumen's build (plan W1.34)", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  it("webr is a devDependency (types and the manifest), never a runtime dependency", () => {
    expect(pkg.dependencies.webr).toBeUndefined();
    expect(pkg.devDependencies.webr).toBeDefined();
  });
  it("predev / prebuild do not stage it; staging it is the operator's opt-in", () => {
    expect(pkg.scripts.prebuild).not.toContain("copy-webr");
    expect(pkg.scripts.predev).not.toContain("copy-webr");
    expect(pkg.scripts["webr:local"]).toBe("node scripts/copy-webr.mjs");
  });
  it("the licence gate needs no webR exception", () => {
    const allow = JSON.parse(readFileSync(join(ROOT, "licenses.allow.json"), "utf8"));
    expect(allow.exceptions.filter((e: { name: string }) => e.name === "webr")).toEqual([]);
  });
  it("the app imports webR's code only from where it is served, never from the package", () => {
    const sources = ["plugins/r/rRuntime.ts", "plugins/r/webrModule.ts", "plugins/LiveRBlock.tsx"].map((f) => readFileSync(join(ROOT, "src", f), "utf8"));
    for (const s of sources) expect(s).not.toMatch(/import\(\s*["']webr["']\s*\)|^import\s+(?!type\b)[^;]*from\s+["']webr["']/m);
  });
});
