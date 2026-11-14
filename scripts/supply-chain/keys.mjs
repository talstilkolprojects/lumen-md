#!/usr/bin/env node
/**
 * Make the release signing key (plan W1.27) — once, on the release owner's
 * own machine. The secret key never goes into the repo or a CI system.
 *
 *   LUMEN_RELEASE_PASSPHRASE=… node scripts/supply-chain/keys.mjs --out ~/.lumen-release
 *
 * Writes <out>/lumen-release.key (PKCS#8, encrypted with the passphrase when
 * it is set; file mode 0600) and <out>/lumen-release.pub (minisign format),
 * and prints the public key. Commit the public key as
 * security/release-key.pub; keep the secret key and its passphrase offline
 * (a password manager and a second, offline copy).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { generateKeys } from "./minisign.mjs";
import { opts } from "./lib.mjs";

const o = opts(process.argv);
const out = resolve(o.get("--out", join(homedir(), ".lumen-release")));
const keyFile = join(out, "lumen-release.key");
if (existsSync(keyFile) && !o.has("--force")) {
  console.error(`${keyFile} exists. Refusing to replace a release key (pass --force to make a new one; old releases stay signed with the old key).`);
  process.exit(1);
}
const passphrase = process.env.LUMEN_RELEASE_PASSPHRASE || undefined;
if (!passphrase) console.warn("LUMEN_RELEASE_PASSPHRASE is not set: the secret key is stored unencrypted.");
const { pem, publicKey } = generateKeys(passphrase);
mkdirSync(out, { recursive: true, mode: 0o700 });
writeFileSync(keyFile, pem, { mode: 0o600 });
writeFileSync(join(out, "lumen-release.pub"), publicKey);
console.log(`Secret key: ${keyFile}\nPublic key (commit as security/release-key.pub):\n\n${publicKey}`);
