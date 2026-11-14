/**
 * Measurement receipts for the nightly runs (plan W4.36; 0.5, 0.11, 0.14).
 *
 * Without GitHub Actions there is no run log anyone else can open, so every
 * nightly report carries its own proof: what ran (commands, exit codes,
 * durations), on which commit and machine, and the sha256 of each step's
 * output. The report is signed with an Ed25519 key that lives only on the
 * machine that runs the nightly (~/.config/lumen-md/nightly-ed25519.pem,
 * mode 0600, made on the first run); its public half is committed as
 * reports/nightly/PUBLIC_KEY.pem, so anyone can check a committed report
 * with `npm run nightly -- --verify <file>`, and a changed number breaks the
 * signature.
 *
 * Canonical form: JSON with object keys sorted, no whitespace, the
 * `receipt` field left out. `receipt.sha256` is the digest of that text and
 * `receipt.signature` the Ed25519 signature over the same bytes (base64).
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** JSON with sorted keys and no whitespace: the bytes a receipt signs. */
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonical(v))).join(",")}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** The report without its receipt, as signed bytes. */
function body(report) {
  const { receipt: _r, ...rest } = report;
  return canonical(rest);
}

/** A copy of `report` with `receipt` = { sha256, alg, signature, publicKey fingerprint }. */
export function seal(report, privateKeyPem) {
  const text = body(report);
  const key = createPrivateKey(privateKeyPem);
  const pub = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
  return {
    ...report,
    receipt: {
      sha256: sha256(text),
      alg: "ed25519",
      signature: sign(null, Buffer.from(text), key).toString("base64"),
      key: sha256(pub).slice(0, 16),
    },
  };
}

/**
 * Check a sealed report: the digest always, the signature when a public key
 * is given. Returns { ok, problems }.
 */
export function check(report, publicKeyPem) {
  const problems = [];
  const r = report?.receipt;
  if (!r) return { ok: false, problems: ["no receipt"] };
  const text = body(report);
  if (r.sha256 !== sha256(text)) problems.push("the digest does not match the report: it was changed after it was sealed");
  if (publicKeyPem) {
    if (r.key !== sha256(createPublicKey(publicKeyPem).export({ type: "spki", format: "pem" }).toString()).slice(0, 16)) problems.push("signed with another key than reports/nightly/PUBLIC_KEY.pem");
    else if (!verify(null, Buffer.from(text), createPublicKey(publicKeyPem), Buffer.from(r.signature ?? "", "base64"))) problems.push("the signature does not verify");
  }
  return { ok: problems.length === 0, problems };
}

/** Where the private key lives: LUMEN_NIGHTLY_KEY, else ~/.config/lumen-md/nightly-ed25519.pem. */
export const keyPath = (env = process.env) => env.LUMEN_NIGHTLY_KEY || join(homedir(), ".config", "lumen-md", "nightly-ed25519.pem");

/** The private key (made on first use, mode 0600) and its public half. */
export function loadOrCreateKey(path = keyPath()) {
  if (!existsSync(path)) {
    const { privateKey } = generateKeyPairSync("ed25519");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  const privateKeyPem = readFileSync(path, "utf8");
  const publicKeyPem = createPublicKey(createPrivateKey(privateKeyPem)).export({ type: "spki", format: "pem" }).toString();
  return { privateKeyPem, publicKeyPem };
}
