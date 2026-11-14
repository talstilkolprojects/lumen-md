/**
 * Plan W7.23: built the same on Vercel and on Cloudflare Workers Builds.
 * The manifest, the comparison, the streak of identical commits, and the
 * in-toto statement for W7.22; the CLI end to end on two local "builds".
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MANIFEST_PATH, PREDICATE_TYPE, attestation, compareManifests, manifestOf, reportLines, streak, withResult, type BuildManifest } from "../../scripts/supply-chain/two-hosts-lib.mjs";

const ROOT = resolve(__dirname, "..", "..");
const meta = (host: string): Omit<BuildManifest, "v" | "files"> => ({ commit: "a".repeat(40), lockfile: "l1", node: "v22.13.0", host, builtAt: "2026-11-14T10:00:00Z" });
const files = [
  { path: "index.html", hash: "h1" },
  { path: "assets/app.js", hash: "h2" },
  { path: MANIFEST_PATH, hash: "self" },
];

describe("two-host reproducible build (W7.23)", () => {
  it("a manifest lists every file but itself, sorted", () => {
    const m = manifestOf(files, meta("vercel"));
    expect(Object.keys(m.files)).toEqual(["assets/app.js", "index.html"]);
    expect(m.host).toBe("vercel");
  });

  it("compares file by file; host, Node and build time are context, not content", () => {
    const a = manifestOf(files, meta("vercel"));
    const b = manifestOf(files, { ...meta("cloudflare"), node: "v22.14.0", builtAt: "2026-11-14T10:07:00Z" });
    expect(compareManifests(a, b)).toMatchObject({ comparable: true, identical: true, total: 2, same: 2 });
    const c = { ...b, files: { ...b.files, "assets/app.js": "zz", "extra.txt": "h9" } };
    const r = compareManifests(a, c);
    expect(r).toMatchObject({ identical: false, differ: ["assets/app.js"], onlyB: ["extra.txt"], onlyA: [] });
    expect(compareManifests(a, { ...b, commit: "b".repeat(40) })).toMatchObject({ comparable: false });
    expect(compareManifests(a, { ...b, lockfile: "l2" })).toMatchObject({ comparable: false });
    expect(compareManifests({ ...a, files: {} }, { ...b, files: {} }).identical).toBe(false);
  });

  it("the streak counts consecutive identical commits at the end; a rerun of a commit replaces its entry", () => {
    let h = [] as Array<{ commit: string; date: string; identical: boolean }>;
    for (let i = 0; i < 12; i++) h = withResult(h, { commit: `c${i}`, date: "d", identical: i !== 1 });
    expect(streak(h)).toBe(10);
    h = withResult(h, { commit: "c11", date: "d", identical: false });
    expect(streak(h)).toBe(0);
    expect(h.length).toBe(12);
  });

  it("an identical build gets an in-toto statement for W7.22; a different one gets none", () => {
    const a = manifestOf(files, meta("vercel"));
    const b = manifestOf(files, meta("cloudflare"));
    const st = attestation(compareManifests(a, b), a, b);
    expect(st?._type).toBe("https://in-toto.io/Statement/v1");
    expect(st?.predicateType).toBe(PREDICATE_TYPE);
    expect(st?.subject).toEqual([{ name: "assets/app.js", digest: { sha256: "h2" } }, { name: "index.html", digest: { sha256: "h1" } }]);
    expect((st?.predicate.builders as Array<{ host: string }>).map((x) => x.host)).toEqual(["vercel", "cloudflare"]);
    const c = { ...b, files: { ...b.files, "index.html": "x" } };
    expect(attestation(compareManifests(a, c), a, c)).toBeNull();
    expect(reportLines(compareManifests(a, c), [])[0]).toMatch(/1\/2 files identical — 1 differ/);
  });

  it("the CLI: two local builds, identical then one file changed (exit 0, then 1, streak reset)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "two-hosts-test-"));
    const a = join(tmp, "a");
    mkdirSync(join(a, "assets"), { recursive: true });
    writeFileSync(join(a, "index.html"), "<!doctype html><title>x</title>");
    writeFileSync(join(a, "assets/app.js"), "console.log(1)");
    const b = join(tmp, "b");
    cpSync(a, b, { recursive: true });
    const manifest = (dir: string, host: string) => spawnSync(process.execPath, ["-e", `import(${JSON.stringify(join(ROOT, "scripts/supply-chain/dist-manifest.mjs"))}).then((m) => m.writeManifest(${JSON.stringify(dir)}, ".", { LUMEN_BUILD_HOST: ${JSON.stringify(host)}, VERCEL_GIT_COMMIT_SHA: "${"c".repeat(40)}" }))`], { cwd: ROOT, encoding: "utf8" });
    // writeManifest reads <root>/package-lock.json: give each "build" one.
    for (const d of [a, b]) writeFileSync(join(d, "package-lock.json"), "{}");
    expect(manifest(a, "vercel").status).toBe(0);
    expect(manifest(b, "cloudflare").status).toBe(0);
    const run = () => spawnSync(process.execPath, [join(ROOT, "scripts/supply-chain/two-hosts.mjs"), "--a", a, "--b", b, "--out", join(tmp, "out")], { cwd: ROOT, encoding: "utf8" });
    const ok = run();
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/3\/3 files identical/);
    expect(JSON.parse(readFileSync(join(tmp, "out", `${"c".repeat(40)}.intoto.json`), "utf8")).predicate.identical).toBe(true);
    writeFileSync(join(b, "assets/app.js"), "console.log(2)");
    expect(manifest(b, "cloudflare").status).toBe(0);
    const bad = run();
    expect(bad.status).toBe(1);
    expect(bad.stdout).toMatch(/differs: assets\/app.js/);
    expect(bad.stdout).toMatch(/streak: 0/);
  });
});
