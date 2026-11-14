#!/usr/bin/env node
/**
 * Signed review receipts (plan W6.11, review 14.11). Every lane posts on
 * GitHub as the same account, so a receipt's `reviewer` field alone can't
 * show the reviewer isn't the author. With `security/reviewers.json` in the
 * tree, pr:check counts a receipt only when it is signed with the Ed25519
 * key of the reviewer it names.
 *
 *   node scripts/review-sign.mjs keygen <reviewer> --out <dir>
 *       a new key: <dir>/<reviewer>.key.pem (private, mode 600, keep it out
 *       of every repository) and the entry to add to security/reviewers.json
 *   node scripts/review-sign.mjs sign <receipt.json> --key <dir>/<reviewer>.key.pem [--comment]
 *       adds `signature` to the receipt file; --comment prints the PR comment
 *   node scripts/review-sign.mjs verify <receipt.json> [--reviewers security/reviewers.json]
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseReviewers, receiptComment, receiptProblems, signatureProblems, signedBytes } from "./lib/independentReview.mjs";

/** A new Ed25519 key pair → { privatePem, publicKey (base64 SPKI DER, the registry's form) }. */
export function keygen() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
}

/** The receipt with its `signature` set, made with the private key `pem`. */
export function signReceipt(receipt, pem) {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`the key is ${key.asymmetricKeyType}, not Ed25519`);
  const { signature: _old, ...rest } = receipt;
  void _old;
  return { ...rest, signature: sign(null, signedBytes(rest), key).toString("base64") };
}

/** The registry entry for a private key's public half. */
export function registryEntry(reviewer, pem) {
  const pub = createPublicKey(createPrivateKey(pem)).export({ type: "spki", format: "der" }).toString("base64");
  return { [reviewer]: { publicKey: pub } };
}

function main(argv) {
  const [cmd, arg] = argv;
  const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  if (cmd === "keygen" && arg) {
    const dir = resolve(opt("--out") ?? ".");
    mkdirSync(dir, { recursive: true });
    const k = keygen();
    const file = join(dir, `${arg}.key.pem`);
    writeFileSync(file, k.privatePem, { mode: 0o600 });
    chmodSync(file, 0o600);
    console.error(`private key: ${file} (keep it out of every repository)`);
    console.log(JSON.stringify({ [arg]: { publicKey: k.publicKey } }, null, 2));
    return 0;
  }
  if (cmd === "sign" && arg && opt("--key")) {
    const r = JSON.parse(readFileSync(arg, "utf8"));
    const shape = receiptProblems(r);
    if (shape.length) {
      console.error(`not signed — the receipt is not well formed: ${shape.join("; ")}`);
      return 1;
    }
    const signed = signReceipt(r, readFileSync(opt("--key"), "utf8"));
    writeFileSync(arg, JSON.stringify(signed, null, 2) + "\n");
    if (argv.includes("--comment")) console.log(receiptComment(signed));
    else console.error(`signed ${arg} as ${signed.reviewer}`);
    return 0;
  }
  if (cmd === "verify" && arg) {
    const r = JSON.parse(readFileSync(arg, "utf8"));
    const reviewers = parseReviewers(readFileSync(opt("--reviewers") ?? "security/reviewers.json", "utf8"));
    const p = [...receiptProblems(r), ...signatureProblems(r, reviewers), ...reviewers.problems];
    console.log(p.length ? p.map((x) => `✖ ${x}`).join("\n") : `✓ signed by ${r.reviewer}`);
    return p.length ? 1 : 0;
  }
  console.error("usage: review-sign.mjs keygen <reviewer> --out <dir> | sign <receipt.json> --key <pem> [--comment] | verify <receipt.json> [--reviewers <file>]");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main(process.argv.slice(2)));
