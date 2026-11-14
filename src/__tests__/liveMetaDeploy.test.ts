/**
 * Audit W10.C29 (plan W6.2): live:meta runs on every deploy path, not only
 * in the nightly.
 *  - vercel-build: a `live:meta` gate on dist/ (the files Vercel deploys),
 *    on production and preview builds, right after the build.
 *  - release.mjs deploy-beta: the deployment's URL is checked before it gets
 *    an alias; a failure exits 1 with an ALERT and no alias. Run for real
 *    against a local HTTP server, with only `npx` (the Vercel CLI) stubbed.
 *  - pages-deploy.sh: dist/ before the upload, the deployment URL after it.
 * The deploy outputs below are synthetic, written in the shape the CLIs print.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// @ts-expect-error — plain .mjs script without type declarations
import { GATES, GATE_EXTRA, PREVIEW_GATES, PRODUCTION_GATES } from "../../scripts/vercel-build.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { deploymentUrlFrom, foreignHost } from "../../scripts/lib/liveMeta.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { liveMetaAlert, liveMetaReport } from "../../scripts/live-meta.mjs";

const repo = process.cwd();
const page = (host: string) => readFileSync(join(repo, "index.html"), "utf8").replaceAll("lumen-md.vercel.app", host);
const files = (host = "lumen-md.vercel.app") => ({
  "index.html": page(host),
  "robots.txt": readFileSync(join(repo, "public/robots.txt"), "utf8").replaceAll("lumen-md.vercel.app", host),
  "sitemap.xml": readFileSync(join(repo, "public/sitemap.xml"), "utf8").replaceAll("lumen-md.vercel.app", host),
});

let tmp: string[] = [];
let server: Server | null = null;
afterEach(async () => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
  tmp = [];
  if (server) await new Promise((r) => server!.close(r));
  server = null;
});
const dir = (f: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), "live-meta-"));
  tmp.push(d);
  for (const [n, t] of Object.entries(f)) {
    mkdirSync(join(d, n, ".."), { recursive: true });
    writeFileSync(join(d, n), t);
  }
  return d;
};
async function serve(f: Record<string, string>): Promise<string> {
  server = createServer((req, res) => {
    const name = req.url === "/" ? "index.html" : (req.url ?? "").slice(1);
    if (!(name in f)) return void res.writeHead(404).end();
    res.writeHead(200).end(f[name]);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function run(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((done) => {
    const p = spawn(cmd, args, opts);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => done({ code, out, err }));
  });
}

describe("vercel-build runs live:meta on what it deploys", () => {
  it("production and preview builds check dist/ right after the build, with the self-test", () => {
    for (const gates of [PRODUCTION_GATES, PREVIEW_GATES]) expect(gates.indexOf("live:meta")).toBe(gates.indexOf("build") + 1);
    expect([...GATES["live:meta"], ...GATE_EXTRA["live:meta"]]).toEqual(["run", "-s", "live:meta", "--", "--dir", "dist", "--self-test"]);
    expect(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts["live:meta"]).toBe("node scripts/live-meta.mjs");
  });

  it("a build whose metadata names the foreign domain fails; ours passes", async () => {
    expect((await liveMetaReport({ dir: dir(files()), selfTest: true })).ok).toBe(true);
    const bad = await liveMetaReport({ dir: dir(files(foreignHost())), selfTest: true });
    expect(bad.ok).toBe(false);
    expect(bad.problems.join("\n")).toMatch(/names the domain that is not ours/);
    expect(liveMetaAlert("dist", bad.problems)).toMatch(/^✗ ALERT live:meta/);
  });
});

describe("the deployment URL a deploy printed", () => {
  it("takes the last Vercel or Pages URL", () => {
    expect(deploymentUrlFrom("Inspect: https://vercel.com/x/y/abc\nProduction: https://lumen-md-abc123-tal.vercel.app [3s]\nhttps://lumen-md-abc123-tal.vercel.app\n")).toBe("https://lumen-md-abc123-tal.vercel.app");
    expect(deploymentUrlFrom("✨ Success! Uploaded 12 files (3.1 sec)\n✨ Deployment complete! Take a peek over at https://1a2b3c4d.lumen-md.pages.dev.")).toBe("https://1a2b3c4d.lumen-md.pages.dev");
    expect(deploymentUrlFrom("nothing deployed")).toBeNull();
  });
});

describe("release.mjs deploy-beta checks the deployment before it gets an alias", () => {
  async function deployBeta(served: Record<string, string>) {
    const base = await serve(served);
    const work = dir({ "package.json": JSON.stringify({ name: "x", version: "1.2.0-beta.1" }), "dist/index.html": "<!doctype html>" });
    const bin = dir({});
    const log = join(bin, "npx.log");
    // The Vercel CLI, stubbed: it logs its arguments and prints the deployment URL as its last line.
    writeFileSync(join(bin, "npx"), `#!/bin/sh\necho "$@" >> "${log}"\n[ "$2" = deploy ] && echo "${base}"\nexit 0\n`);
    chmodSync(join(bin, "npx"), 0o755);
    const r = await run(process.execPath, [resolve(repo, "scripts/release.mjs"), "deploy-beta"], { cwd: work, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LUMEN_BETA_HOST: "beta.example.test" } });
    let calls = "";
    try {
      calls = readFileSync(log, "utf8");
    } catch {
      /* npx never ran */
    }
    return { ...r, calls };
  }

  it("a deployment that names the foreign domain: exit 1, ALERT, no alias", async () => {
    const r = await deployBeta(files(foreignHost()));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/ALERT live:meta/);
    expect(r.calls).toMatch(/^vercel deploy dist --yes$/m);
    expect(r.calls).not.toMatch(/alias/);
  });

  it("a clean deployment is checked, then aliased", async () => {
    const r = await deployBeta(files());
    expect(r.out).toMatch(/live:meta http:\/\/127\.0\.0\.1:\d+ — \d+ URLs checked, 0 problems/);
    expect(r.calls).toMatch(/^vercel alias set http:\/\/127\.0\.0\.1:\d+ beta\.example\.test$/m);
  });
});

describe("pages-deploy.sh", () => {
  it("checks dist/ before the upload and the deployment URL after it, and alerts when it has none", () => {
    const sh = readFileSync(join(repo, "scripts/pages-deploy.sh"), "utf8");
    const at = (s: string) => sh.indexOf(s);
    expect(at("node scripts/live-meta.mjs --dir dist --self-test")).toBeGreaterThan(-1);
    expect(at("node scripts/live-meta.mjs --dir dist --self-test")).toBeLessThan(at("wrangler@4 pages deploy"));
    expect(at('node scripts/live-meta.mjs --url "$url"')).toBeGreaterThan(at("wrangler@4 pages deploy"));
    expect(sh).toMatch(/deploymentUrlFrom/);
    expect(sh).toMatch(/ALERT live:meta: wrangler printed no deployment URL/);
  });
});
