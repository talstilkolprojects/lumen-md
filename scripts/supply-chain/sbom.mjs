#!/usr/bin/env node
/**
 * Software bill of materials (plan W1.27): CycloneDX 1.5 JSON of everything
 * a release is built from — every npm package in package-lock.json and
 * every crate in src-tauri/Cargo.lock, with versions, package URLs, the
 * lockfiles' hashes and licences.
 *
 *   node scripts/supply-chain/sbom.mjs [--out release/sbom.cdx.json] [--root .]
 *
 * Reproducible: the same lockfiles and SOURCE_DATE_EPOCH (default: the
 * commit time) give the same bytes, serial number included.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function sourceDate(root) {
  if (process.env.SOURCE_DATE_EPOCH) return new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000);
  try {
    return new Date(Number(execFileSync("git", ["log", "-1", "--format=%ct"], { cwd: root, encoding: "utf8" }).trim()) * 1000);
  } catch {
    return new Date(0);
  }
}

const npmPurl = (name, version) => `pkg:npm/${name.startsWith("@") ? "%40" + name.slice(1) : name}@${version}`;

function npmComponents(lock) {
  const out = [];
  for (const [path, p] of Object.entries(lock.packages ?? {})) {
    if (!path || !p.version || p.link) continue;
    const name = p.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    const c = { type: "library", "bom-ref": `${npmPurl(name, p.version)}#${path}`, name, version: p.version, purl: npmPurl(name, p.version), scope: p.dev ? "excluded" : "required" };
    const m = /^(sha\d+)-(.+)$/.exec(p.integrity ?? "");
    if (m) c.hashes = [{ alg: m[1].replace("sha", "SHA-"), content: Buffer.from(m[2], "base64").toString("hex") }];
    if (p.license) c.licenses = [/[ ()]/.test(p.license) ? { expression: p.license } : { license: { id: p.license } }];
    if (p.resolved) c.externalReferences = [{ type: "distribution", url: p.resolved }];
    out.push(c);
  }
  return out;
}

function cargoComponents(text) {
  const out = [];
  for (const block of text.split(/\n\[\[package\]\]\n/).slice(1)) {
    const get = (k) => new RegExp(`^${k} = "([^"]*)"`, "m").exec(block)?.[1];
    const name = get("name");
    const version = get("version");
    if (!name || !version) continue;
    const purl = `pkg:cargo/${name}@${version}`;
    const c = { type: "library", "bom-ref": purl, name, version, purl, scope: "required" };
    const sum = get("checksum");
    if (sum) c.hashes = [{ alg: "SHA-256", content: sum }];
    const source = get("source");
    if (!source) c.properties = [{ name: "lumen:source", value: "workspace" }];
    out.push(c);
  }
  return out;
}

/** The SBOM object for the repo at `root`. */
export function buildSbom(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const cargoLock = join(root, "src-tauri", "Cargo.lock");
  const components = [...npmComponents(lock), ...(existsSync(cargoLock) ? cargoComponents(readFileSync(cargoLock, "utf8")) : [])];
  components.sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"]));
  const body = { components };
  const h = createHash("sha256").update(JSON.stringify(body)).update(pkg.version).digest("hex");
  // A UUID made from the content, so the same inputs give the same file.
  const serial = `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: serial,
    version: 1,
    metadata: {
      timestamp: sourceDate(root).toISOString().replace(/\.\d{3}Z$/, "Z"),
      tools: { components: [{ type: "application", name: "lumen-md scripts/supply-chain/sbom.mjs", version: pkg.version }] },
      component: { type: "application", "bom-ref": `pkg:npm/${pkg.name}@${pkg.version}`, name: pkg.name, version: pkg.version, purl: `pkg:npm/${pkg.name}@${pkg.version}`, licenses: pkg.license ? [{ license: { id: pkg.license } }] : undefined },
    },
    components,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
  const root = resolve(opt("--root", "."));
  const out = resolve(opt("--out", "release/sbom.cdx.json"));
  const sbom = buildSbom(root);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(sbom, null, 2) + "\n");
  const npm = sbom.components.filter((c) => c.purl.startsWith("pkg:npm/")).length;
  console.log(`SBOM: ${sbom.components.length} components (${npm} npm, ${sbom.components.length - npm} cargo) → ${out}`);
}
