/**
 * Signed receipts for the owner's sessions (plan W6.20).
 *
 * The format is the sealed-report format of scripts/nightly/receipt.mjs
 * (#455), which scripts/plan/receipts.mjs (#511) and scripts/plan/areas.mjs
 * (W6.44) read: canonical JSON (keys sorted, no whitespace, `receipt` left
 * out), its sha256, and an Ed25519 signature over the same bytes.
 * It is re-implemented here because this branch does not carry #455's file;
 * src/__tests__/ownerSession.test.ts checks the bytes against an independent
 * copy of the algorithm.
 *
 * The private key lives only on Tal's machine: $LUMEN_OWNER_KEY, else
 * ~/.config/lumen-md/owner-ed25519.pem (0600, made on first use). Its public
 * half is reports/owner/PUBLIC_KEY.pem, committed with the receipts.
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
const bodyOf = (report) => {
  const { receipt: _r, ...rest } = report;
  return canonical(rest);
};
export const fingerprint = (pem) => sha256(createPublicKey(pem).export({ type: "spki", format: "pem" }).toString()).slice(0, 16);

/** A copy of `report` with `receipt` = { sha256, alg, signature, key }. */
export function seal(report, privateKeyPem) {
  const text = bodyOf(report);
  const key = createPrivateKey(privateKeyPem);
  const pub = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
  return { ...report, receipt: { sha256: sha256(text), alg: "ed25519", signature: sign(null, Buffer.from(text), key).toString("base64"), key: sha256(pub).slice(0, 16) } };
}

/** { ok, problems } for a sealed report against one public key. */
export function check(report, publicKeyPem) {
  const r = report?.receipt;
  if (!r) return { ok: false, problems: ["no receipt"] };
  const text = bodyOf(report);
  const problems = [];
  if (r.sha256 !== sha256(text)) problems.push("the digest does not match: changed after sealing");
  else if (r.key !== fingerprint(publicKeyPem)) problems.push("signed with another key than reports/owner/PUBLIC_KEY.pem");
  else if (!verify(null, Buffer.from(text), createPublicKey(publicKeyPem), Buffer.from(r.signature ?? "", "base64"))) problems.push("the signature does not verify");
  return { ok: problems.length === 0, problems };
}

export const keyPath = (env = process.env) => env.LUMEN_OWNER_KEY || join(homedir(), ".config", "lumen-md", "owner-ed25519.pem");

/** The private key (made on first use, mode 0600) and its public half. */
export function loadOrCreateKey(path = keyPath()) {
  if (!existsSync(path)) {
    const { privateKey } = generateKeyPairSync("ed25519");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  const privateKeyPem = readFileSync(path, "utf8");
  return { privateKeyPem, publicKeyPem: createPublicKey(createPrivateKey(privateKeyPem)).export({ type: "spki", format: "pem" }).toString() };
}
