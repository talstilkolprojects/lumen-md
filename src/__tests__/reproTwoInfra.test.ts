/**
 * A reproducible build on two infrastructures (plan W7.23,
 * scripts/supply-chain/repro-*.mjs): manifests, the file-by-file comparison,
 * a deployed origin hashed over HTTP, the ledger's streak and the attestation.
 */
import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// @ts-expect-error -- plain ESM script module, no types
import { attestationStatement, compareManifests, filesDigest, manifestOf, streak, viteEnv } from "../../scripts/supply-chain/repro-lib.mjs";

const ROOT = resolve(__dirname, "..", "..");
const script = (name: string) => join(ROOT, "scripts", "supply-chain", name);

function dist(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lumen-repro-test-"));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return dir;
}

const runAsync = (args: string[], cwd = ROOT) =>
  new Promise<{ status: number | null; stdout: string }>((done) => {
    const p = spawn(process.execPath, args, { cwd });
    let stdout = "";
    p.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    p.stderr.on("data", (d: Buffer) => (stdout += d.toString()));
    p.on("close", (status: number | null) => done({ status, stdout }));
  });

describe("two-infrastructure reproducible build", () => {
  const base = { "index.html": "<!doctype html><title>Lumen</title>", "assets/app-abc.js": "console.log('שלום')", "sw.js": "self.x=1" };

  it("lists every file with its SHA-256 and leaves out the build's own manifest", () => {
    const d = dist({ ...base, ".well-known/lumen-build.json": "{}", "lumen-build.json": "{}" });
    const m = manifestOf(d, { commit: "c1" });
    expect(Object.keys(m.files)).toEqual(["assets/app-abc.js", "index.html", "sw.js"]);
    expect(m.files["index.html"].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.fileCount).toBe(3);
    rmSync(d, { recursive: true, force: true });
  });

  it("names each file that differs or exists on one side only, and refuses two commits", () => {
    const a = manifestOf(dist(base), { commit: "c1", lockfileSha256: "L" });
    const b = manifestOf(dist({ ...base, "sw.js": "self.x=2", "extra.txt": "x" }), { commit: "c1", lockfileSha256: "L" });
    const r = compareManifests(a, b);
    expect(r.identical).toBe(false);
    expect(r.differs.map((d: { path: string }) => d.path)).toEqual(["sw.js"]);
    expect(r.onlyB).toEqual(["extra.txt"]);
    expect(r.same).toBe(2);
    expect(compareManifests(a, { ...a, commit: "c2" }).errors[0]).toMatch(/different commits/);
    expect(compareManifests({ ...a, node: "v22.23.4" }, { ...a, node: "v24.22.1", viteEnv: { VITE_X: "1" } }).notes.length).toBe(2);
  });

  it("hashes VITE_* values instead of recording them", () => {
    const v = viteEnv({ VITE_LUMEN_CHANNEL: "beta", PATH: "/bin", SECRET: "s" });
    expect(Object.keys(v)).toEqual(["VITE_LUMEN_CHANNEL"]);
    expect(v.VITE_LUMEN_CHANNEL).not.toContain("beta");
  });

  it("counts the newest run of identical commits, one verdict per commit", () => {
    const e = (commit: string, at: string, identical: boolean) => ({ commit, at, identical });
    expect(streak([e("a", "2026-11-01", true), e("b", "2026-11-02", false), e("c", "2026-11-03", true), e("d", "2026-11-04", true)])).toBe(2);
    // b re-checked later and identical: its latest verdict counts
    expect(streak([e("a", "2026-11-01", true), e("b", "2026-11-02", false), e("b", "2026-11-05", true)])).toBe(2);
  });

  it("attests only an identical comparison: one subject per file, the files digest in the predicate", () => {
    const a = manifestOf(dist(base), { commit: "c1", builder: "cloudflare-workers-builds" });
    const b = manifestOf(dist(base), { commit: "c1", builder: "vercel" });
    const s = attestationStatement(a, b, compareManifests(a, b));
    expect(s.subject.map((x: { name: string }) => x.name)).toEqual(["assets/app-abc.js", "index.html", "sw.js"]);
    expect(s.subject[1].digest.sha256).toBe(a.files["index.html"].sha256);
    expect(s.predicate.filesDigest).toBe(filesDigest(a));
    expect(s.predicate.builders.map((x: { id: string }) => x.id)).toEqual(["cloudflare-workers-builds", "vercel"]);
    const c = manifestOf(dist({ ...base, "sw.js": "x" }), { commit: "c1" });
    expect(() => attestationStatement(a, c, compareManifests(a, c))).toThrow(/identical/);
  });

  it("repro-compare: manifest vs a deployed origin over HTTP, the ledger and the statement", async () => {
    const a = dist(base);
    const work = mkdtempSync(join(tmpdir(), "lumen-repro-cli-"));
    const mf = join(work, "cf.json");
    const made = spawnSync(process.execPath, [script("dist-manifest.mjs"), "--dir", a, "--builder", "cloudflare-workers-builds", "--out", mf], { cwd: ROOT, encoding: "utf8" });
    expect(made.status).toBe(0);
    let served = { ...base };
    const server = createServer((req, res) => {
      const p = decodeURIComponent((req.url ?? "/").slice(1)) as keyof typeof served;
      if (served[p] === undefined) return void res.writeHead(404).end();
      res.writeHead(200).end(served[p]);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const origin = `origin:http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const ledger = join(work, "ledger.jsonl");
      const ok = await runAsync([script("repro-compare.mjs"), mf, origin, "--ledger", ledger, "--attest", join(work, "s.json")]);
      expect(ok.stdout).toMatch(/IDENTICAL: 3 files/);
      expect(ok.stdout).toMatch(/1 consecutive identical commit/);
      expect(ok.status).toBe(0);
      expect(JSON.parse(readFileSync(join(work, "s.json"), "utf8")).predicateType).toMatch(/two-infra-build/);
      served = { ...base, "sw.js": "self.x=2" } as typeof served;
      delete (served as Record<string, string>)["index.html"];
      const bad = await runAsync([script("repro-compare.mjs"), mf, origin, "--ledger", ledger, "--diffoscope", "/a", "/b"]);
      expect(bad.status).toBe(1);
      expect(bad.stdout).toMatch(/differs {6}sw\.js/);
      expect(bad.stdout).toMatch(/only in cloudflare-workers-builds: index\.html/);
      expect(bad.stdout).toMatch(/diffoscope --text - "\/a\/sw\.js" "\/b\/sw\.js"/);
      expect(bad.stdout).toMatch(/0 consecutive identical/);
    } finally {
      server.close();
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("repro-compare: two build directories; a path or a clock in the output is caught", () => {
    const a = dist({ ...base, "assets/built.js": "/tmp/a/src/x" });
    const b = dist({ ...base, "assets/built.js": "/tmp/a much longer path/b/src/x" });
    const r = spawnSync(process.execPath, [script("repro-compare.mjs"), a, b], { cwd: ROOT, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/DIFFERENT: 3\/4 files identical \(75\.00 %\), 1 differ/);
    const same = spawnSync(process.execPath, [script("repro-compare.mjs"), a, a], { cwd: ROOT, encoding: "utf8" });
    expect(same.status).toBe(0);
  });
});
