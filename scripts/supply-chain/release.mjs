#!/usr/bin/env node
/**
 * Sign a release (plan W1.27), locally — no CI system holds the key.
 *
 *   npm run build
 *   LUMEN_RELEASE_PASSPHRASE=… node scripts/supply-chain/release.mjs \
 *     --key ~/.lumen-release/lumen-release.key [--dist dist] [--out release] \
 *     [--artifact path …]
 *
 * Writes into --out:
 *   SHA256SUMS          every file of --dist (as dist/…) and each --artifact
 *   sbom.cdx.json       CycloneDX SBOM (scripts/supply-chain/sbom.mjs)
 *   *.minisig           minisign signatures of both
 * then checks the whole release with verify-release.mjs. The trusted
 * comment of each signature names the version, the commit and the time.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { checksums, filesUnder, isFile, opts, sha256File } from "./lib.mjs";
import { readSecretKey, signData } from "./minisign.mjs";
import { buildSbom, sourceDate } from "./sbom.mjs";
import { verifyRelease } from "./verify-release.mjs";

const o = opts(process.argv);
const root = resolve(o.get("--root", "."));
const dist = resolve(root, o.get("--dist", "dist"));
const out = resolve(root, o.get("--out", "release"));
const keyPath = o.get("--key", process.env.LUMEN_RELEASE_KEY);
if (!keyPath) {
  console.error("--key <secret key file> is required (see scripts/supply-chain/keys.mjs).");
  process.exit(2);
}
const artifacts = o.args.flatMap((a, i) => (o.args[i - 1] === "--artifact" ? [resolve(a)] : []));
const pem = readFileSync(resolve(keyPath), "utf8");
const passphrase = process.env.LUMEN_RELEASE_PASSPHRASE || undefined;
try {
  readSecretKey(pem, passphrase);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
let commit = "unknown";
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
} catch {
  /* not a git checkout */
}
const when = Math.floor(sourceDate(root).getTime() / 1000);

const entries = filesUnder(dist).map((p) => ({ path: `dist/${p}`, hash: sha256File(join(dist, p)) }));
for (const a of artifacts) {
  if (!isFile(a)) throw new Error(`No such artifact: ${a}`);
  entries.push({ path: basename(a), hash: sha256File(a) });
}
if (!entries.length) throw new Error(`Nothing to sign: ${dist} is empty (run npm run build first).`);
mkdirSync(out, { recursive: true });
const sums = checksums(entries);
const sbom = JSON.stringify(buildSbom(root), null, 2) + "\n";
writeFileSync(join(out, "SHA256SUMS"), sums);
writeFileSync(join(out, "sbom.cdx.json"), sbom);
for (const [name, data] of [["SHA256SUMS", sums], ["sbom.cdx.json", sbom]]) {
  const trusted = `lumen-md ${pkg.version} commit:${commit} file:${name} timestamp:${when}`;
  writeFileSync(join(out, `${name}.minisig`), signData(Buffer.from(data), pem, { passphrase, trusted }));
}
console.log(`Signed ${entries.length} files of lumen-md ${pkg.version} (${commit.slice(0, 12)}) → ${out}`);
const pub = o.get("--pub", join(root, "security", "release-key.pub"));
const r = verifyRelease({ dir: out, root, pub: isFile(pub) ? readFileSync(pub, "utf8") : null, pem, passphrase });
console.log(r.ok ? `Verified: ${r.checked} files, 2 signatures, key ${r.keyId}${r.keyFrom === "secret key" ? " (security/release-key.pub not committed yet)" : ""}.` : `NOT VERIFIED: ${r.errors.join("; ")}`);
process.exit(r.ok ? 0 : 1);
