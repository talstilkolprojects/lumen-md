/**
 * Plan W7.23, the cases of lane W7X's #575 (superseded by this branch), on the
 * consolidated scripts: Vercel's `manifest` gate and Cloudflare Workers Builds
 * write the same manifest, compared file by file; host, Node and build time are
 * context; the streak; the in-toto statement; the CLI on two local "builds".
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// @ts-expect-error -- plain ESM script module, no types
import { MANIFEST_PATH, PREDICATE_TYPE, STREAK_TARGET, attestationStatement, compareManifests, ledgerEntry, manifestOf, streak } from "../../scripts/supply-chain/repro-lib.mjs";

const ROOT = resolve(__dirname, "..", "..");
const COMMIT = "a".repeat(40);
const meta = (builder: string) => ({ commit: COMMIT, lockfileSha256: "l1", node: "v22.13.0", builder, builtAt: "2026-11-14T10:00:00Z" });

function build(): string {
  const d = mkdtempSync(join(tmpdir(), "two-host-test-"));
  mkdirSync(join(d, "assets"), { recursive: true });
  writeFileSync(join(d, "index.html"), "<!doctype html><title>x</title>");
  writeFileSync(join(d, "assets/app.js"), "console.log(1)");
  return d;
}

describe("two-host reproducible build (W7.23, #575's cases)", () => {
  it("a manifest lists every file but the build's own manifest, sorted", () => {
    const d = build();
    mkdirSync(join(d, ".well-known"));
    writeFileSync(join(d, MANIFEST_PATH), "{}");
    const m = manifestOf(d, meta("vercel"));
    expect(Object.keys(m.files)).toEqual(["assets/app.js", "index.html"]);
    expect(m.builder).toBe("vercel");
  });

  it("compares file by file; host, Node and build time are context, not content", () => {
    const d = build();
    const a = manifestOf(d, meta("vercel"));
    const b = manifestOf(d, { ...meta("cloudflare-workers-builds"), node: "v22.14.0", builtAt: "2026-11-14T10:07:00Z" });
    expect(compareManifests(a, b)).toMatchObject({ identical: true, total: 2, same: 2 });
    const c = { ...b, files: { ...b.files, "assets/app.js": { sha256: "zz", size: 1 }, "extra.txt": { sha256: "h9", size: 1 } } };
    const r = compareManifests(a, c);
    expect(r.identical).toBe(false);
    expect(r.differs.map((x: { path: string }) => x.path)).toEqual(["assets/app.js"]);
    expect(r.onlyB).toEqual(["extra.txt"]);
    expect(r.onlyA).toEqual([]);
    expect(compareManifests(a, { ...b, commit: "b".repeat(40) }).errors.length).toBe(1);
    expect(compareManifests(a, { ...b, lockfileSha256: "l2" }).errors.length).toBe(1);
    expect(compareManifests(a, { ...b, commit: "b".repeat(40) }).identical).toBe(false);
    // Two empty builds prove nothing.
    expect(compareManifests({ ...a, files: {} }, { ...b, files: {} }).identical).toBe(false);
  });

  it("the streak counts consecutive identical commits at the end; a rerun of a commit replaces its verdict", () => {
    const at = (i: number) => new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString();
    const h: Array<{ commit: string; at: string; identical: boolean }> = [];
    for (let i = 0; i < 12; i++) h.push({ commit: `c${i}`, at: at(i), identical: i !== 1 });
    expect(streak(h)).toBe(STREAK_TARGET);
    h.push({ commit: "c11", at: at(20), identical: false });
    expect(streak(h)).toBe(0);
  });

  it("an identical build gets an in-toto statement for W7.22; a different one gets none", () => {
    const d = build();
    const a = manifestOf(d, meta("vercel"));
    const b = manifestOf(d, meta("cloudflare-workers-builds"));
    const st = attestationStatement(a, b, compareManifests(a, b));
    expect(st._type).toBe("https://in-toto.io/Statement/v1");
    expect(st.predicateType).toBe(PREDICATE_TYPE);
    expect(st.subject).toEqual([
      { name: "assets/app.js", digest: { sha256: a.files["assets/app.js"].sha256 } },
      { name: "index.html", digest: { sha256: a.files["index.html"].sha256 } },
    ]);
    expect(st.predicate.builders.map((x: { id: string }) => x.id)).toEqual(["vercel", "cloudflare-workers-builds"]);
    const c = { ...b, files: { ...b.files, "index.html": { sha256: "x", size: 1 } } };
    expect(() => attestationStatement(a, c, compareManifests(a, c))).toThrow();
    expect(ledgerEntry(compareManifests(a, c), a, c)).toMatchObject({ commit: COMMIT, identical: false, same: 1, total: 2 });
  });

  it("the CLI: two local builds with their manifests, identical then one file changed (exit 0, then 1, streak reset)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "two-hosts-cli-"));
    const a = build();
    const b = join(tmp, "b");
    cpSync(a, b, { recursive: true });
    for (const d of [a, b]) writeFileSync(join(d, "package-lock.json"), "{}");
    const manifest = (dir: string, builder: string) =>
      spawnSync(process.execPath, [join(ROOT, "scripts/supply-chain/dist-manifest.mjs"), "--root", dir, "--dir", ".", "--builder", builder, "--out", join(dir, MANIFEST_PATH)], { cwd: ROOT, encoding: "utf8", env: { ...process.env, VERCEL_GIT_COMMIT_SHA: "c".repeat(40) } });
    expect(manifest(a, "vercel").status).toBe(0);
    expect(manifest(b, "cloudflare-workers-builds").status).toBe(0);
    const ledger = join(tmp, "ledger.jsonl");
    const run = () => spawnSync(process.execPath, [join(ROOT, "scripts/supply-chain/repro-compare.mjs"), join(a, MANIFEST_PATH), join(b, MANIFEST_PATH), "--ledger", ledger, "--attest", join(tmp, "s.json")], { cwd: ROOT, encoding: "utf8" });
    const ok = run();
    expect(ok.status, ok.stderr).toBe(0);
    // index.html, assets/app.js and the package-lock.json each build carries; not the manifest itself
    expect(ok.stdout).toMatch(/IDENTICAL: 3 files/);
    expect(JSON.parse(readFileSync(join(tmp, "s.json"), "utf8")).predicate.identical).toBe(true);
    writeFileSync(join(b, "assets/app.js"), "console.log(2)");
    expect(manifest(b, "cloudflare-workers-builds").status).toBe(0);
    const bad = run();
    expect(bad.status).toBe(1);
    expect(bad.stdout).toMatch(/differs {6}assets\/app\.js/);
    expect(bad.stdout).toMatch(/0 consecutive identical commit/);
  });
});
