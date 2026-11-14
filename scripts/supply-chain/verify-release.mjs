#!/usr/bin/env node
/**
 * Check a release (plan W1.27): both signatures against the public key,
 * every file against SHA256SUMS, and the SBOM's presence and format.
 *
 *   node scripts/supply-chain/verify-release.mjs [release] [--pub security/release-key.pub] [--root .]
 *
 * Files listed as dist/… are looked up under --root (the unpacked web
 * bundle); others next to SHA256SUMS. Anyone can run this — it needs only
 * the public key. With minisign installed, the same check is
 *   minisign -Vm release/SHA256SUMS -P <public key>  &&  (cd <root> && sha256sum -c release/SHA256SUMS)
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isFile, opts, parseChecksums, sha256File } from "./lib.mjs";
import { formatPublicKey, keyIdHex, parsePublicKey, rawPublicKey, readSecretKey, verifyData } from "./minisign.mjs";

/** Returns { ok, errors, checked, keyId, keyFrom }. `pem` only stands in for a missing public key (right after signing). */
export function verifyRelease({ dir, root, pub, pem, passphrase }) {
  const errors = [];
  let keyText = pub;
  let keyFrom = "public key";
  if (!keyText && pem) {
    keyText = formatPublicKey(rawPublicKey(readSecretKey(pem, passphrase)));
    keyFrom = "secret key";
  }
  if (!keyText) return { ok: false, errors: ["no public key (security/release-key.pub)"], checked: 0, keyId: "", keyFrom };
  const keyId = keyIdHex(parsePublicKey(keyText).id);
  for (const name of ["SHA256SUMS", "sbom.cdx.json"]) {
    const file = join(dir, name);
    if (!isFile(file) || !isFile(`${file}.minisig`)) {
      errors.push(`${name} or its signature is missing`);
      continue;
    }
    try {
      const trusted = verifyData(readFileSync(file), readFileSync(`${file}.minisig`, "utf8"), keyText);
      if (!trusted.includes(`file:${name}`)) errors.push(`${name}.minisig was made for another file (${trusted})`);
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }
  let checked = 0;
  if (isFile(join(dir, "SHA256SUMS"))) {
    for (const { hash, path } of parseChecksums(readFileSync(join(dir, "SHA256SUMS"), "utf8"))) {
      const at = path.startsWith("dist/") ? join(root, path) : join(dir, path);
      if (!existsSync(at)) errors.push(`${path} is missing`);
      else if (sha256File(at) !== hash) errors.push(`${path} does not match SHA256SUMS`);
      else checked++;
    }
  }
  if (isFile(join(dir, "sbom.cdx.json"))) {
    try {
      const s = JSON.parse(readFileSync(join(dir, "sbom.cdx.json"), "utf8"));
      if (s.bomFormat !== "CycloneDX" || !Array.isArray(s.components) || !s.components.length) errors.push("sbom.cdx.json is not a CycloneDX SBOM with components");
    } catch (e) {
      errors.push(`sbom.cdx.json: ${e.message}`);
    }
  }
  return { ok: errors.length === 0, errors, checked, keyId, keyFrom };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = opts(process.argv);
  const dir = resolve(o.args.find((a, i) => !a.startsWith("--") && !o.args[i - 1]?.startsWith("--")) ?? "release");
  const root = resolve(o.get("--root", "."));
  const pubPath = resolve(o.get("--pub", join(root, "security", "release-key.pub")));
  if (!isFile(pubPath)) {
    console.error(`No public key at ${pubPath}.`);
    process.exit(2);
  }
  const r = verifyRelease({ dir, root, pub: readFileSync(pubPath, "utf8") });
  console.log(r.ok ? `OK: ${r.checked} files match SHA256SUMS; SHA256SUMS and sbom.cdx.json are signed by key ${r.keyId}.` : `FAIL:\n  ${r.errors.join("\n  ")}`);
  process.exit(r.ok ? 0 : 1);
}
