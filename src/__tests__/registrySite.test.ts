/**
 * The plugin registry as its own static site (plan W6.35): built from the
 * registry the app ships, within Cloudflare Pages' limits, every file listed
 * with its SHA-256, and a verifier that catches a changed file, a failed
 * scan and a version the scan would refuse.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildSite, pagesProblems, sha256, verifySite } from "../../scripts/lib/registrySite.mjs";
import { scanPluginVersion } from "../plugins/runtime/scan";

const DIR = resolve(__dirname, "../../public/plugins/examples");
const index = JSON.parse(readFileSync(join(DIR, "index.json"), "utf8")) as { plugins: { id: string; versions: { version: string; path: string; sha256: string }[] }[] };
const scan = JSON.parse(readFileSync(join(DIR, "scan.json"), "utf8")) as { scanner: number; results: { id: string; version: string; passed: boolean }[] };
const read = (path: string, file: string) => readFileSync(join(DIR, path, file));
const getter = (files: Map<string, Buffer>) => async (p: string) => files.get(p) ?? null;

describe("registry site (W6.35)", () => {
  it("lists every scanned version with the hashes of its files, and fits Pages", () => {
    const site = buildSite({ index, scan, read, commit: "abc" });
    const total = index.plugins.reduce((n, p) => n + p.versions.length, 0);
    expect(site.index.plugins.reduce((n: number, p: { versions: unknown[] }) => n + p.versions.length, 0)).toBe(total);
    expect(site.skipped).toEqual([]);
    for (const p of index.plugins)
      for (const v of p.versions) {
        const code = site.files.get(`v1/plugins/${p.id}/${v.version}/main.js`);
        expect(code && sha256(code), `${p.id}@${v.version}`).toBe(v.sha256);
      }
    expect(pagesProblems(site.files)).toEqual([]);
    expect(String(site.files.get("_headers"))).toMatch(/\/v1\/plugins\/\*\n {2}Content-Type: text\/plain; charset=utf-8\n {2}Cache-Control: public, max-age=31536000, immutable/);
    expect(String(site.files.get("SHA256SUMS"))).not.toMatch(/_headers/);
  });

  it("verifies clean, and catches a changed file", async () => {
    const site = buildSite({ index, scan, read });
    expect(await verifySite({ get: getter(site.files), scanVersion: scanPluginVersion })).toMatchObject({ ok: true, problems: [] });
    const files = new Map(site.files);
    const key = `v1/plugins/${index.plugins[0].id}/${index.plugins[0].versions[0].version}/main.js`;
    files.set(key, Buffer.concat([files.get(key)!, Buffer.from("\n// changed\n")]));
    const r = await verifySite({ get: getter(files), scanVersion: scanPluginVersion });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/SHA-256 or size differs/);
    expect(r.problems.join("\n")).toMatch(/differs from SHA256SUMS/);
  });

  it("leaves out a version whose scan failed, and the verifier re-scans what a host lists", async () => {
    const failed = { ...scan, results: scan.results.map((r, i) => (i === 0 ? { ...r, passed: false } : r)) };
    const site = buildSite({ index, scan: failed, read });
    expect(site.skipped).toHaveLength(1);
    const r = await verifySite({ get: getter(site.files), scanVersion: async () => ({ passed: false, id: "x", version: "0", findings: [{ rule: "network-undeclared" }] }) });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/fails the scan here \(network-undeclared\)/);
  });

  it("refuses a path-unsafe id instead of writing outside its folder", () => {
    const bad = { plugins: [{ ...index.plugins[0], id: "../x" }] };
    const sc = { ...scan, results: scan.results.map((r) => (r.id === index.plugins[0].id ? { ...r, id: "../x" } : r)) };
    expect(() => buildSite({ index: bad, scan: sc, read })).toThrow(/unsafe id/);
  });
});
