/**
 * Minisign-compatible Ed25519 signatures with Node's own crypto (plan W1.27):
 * no package, no binary. A signature made here verifies with the minisign
 * tool (`minisign -Vm <file> -P <public key>`) and the other way round.
 *
 * Formats (https://jedisct1.github.io/minisign/):
 *   public key   base64( "Ed" ‖ key id (8 bytes) ‖ Ed25519 public key (32) )
 *   signature    untrusted comment line
 *                base64( "ED" ‖ key id ‖ Ed25519( BLAKE2b-512(file) ) )
 *                trusted comment line
 *                base64( Ed25519( signature (64) ‖ trusted comment ) )
 *
 * The secret key stays a standard PKCS#8 PEM file (optionally encrypted
 * with a passphrase), kept by the release owner and never in the repo.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

const ED_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex"); // SPKI header of an Ed25519 key

/** The raw 32-byte public key of a KeyObject. */
export function rawPublicKey(key) {
  const pub = key?.type === "public" ? key : createPublicKey(key);
  const der = pub.export({ type: "spki", format: "der" });
  return Buffer.from(der.subarray(der.length - 32));
}

/** The key id: the first 8 bytes of SHA-256(public key) — stable for a key, like minisign's random id. */
export function keyIdOf(pk) {
  return createHash("sha256").update(pk).digest().subarray(0, 8);
}

/** minisign prints the id as a little-endian 64-bit hex number. */
export const keyIdHex = (id) => Buffer.from(id).reverse().toString("hex").toUpperCase();

export function generateKeys(passphrase) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export(passphrase ? { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase } : { type: "pkcs8", format: "pem" });
  return { pem: String(pem), publicKey: formatPublicKey(rawPublicKey(publicKey)) };
}

export function formatPublicKey(pk) {
  const id = keyIdOf(pk);
  return `untrusted comment: minisign public key ${keyIdHex(id)}\n${Buffer.concat([Buffer.from("Ed"), id, pk]).toString("base64")}\n`;
}

/** The public key from a minisign public-key file's text, or its base64 line alone. */
export function parsePublicKey(text) {
  const line = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("untrusted comment:"));
  const b = Buffer.from(line ?? "", "base64");
  if (b.length !== 42 || b.subarray(0, 2).toString() !== "Ed") throw new Error("Not a minisign Ed25519 public key.");
  return { id: b.subarray(2, 10), pk: b.subarray(10) };
}

const keyFromRaw = (pk) => createPublicKey({ key: Buffer.concat([ED_DER_PREFIX, pk]), format: "der", type: "spki" });

/** The secret key from its PEM text; a clear error for a wrong or missing passphrase. */
export function readSecretKey(pem, passphrase) {
  try {
    return createPrivateKey(passphrase ? { key: pem, passphrase } : pem);
  } catch (e) {
    throw new Error(`Cannot read the release secret key — wrong or missing LUMEN_RELEASE_PASSPHRASE? (${e.code ?? e.message})`);
  }
}

/** Sign `data` with the PEM secret key; returns the .minisig text. */
export function signData(data, pem, { passphrase, trusted = "", untrusted = "signature from the lumen-md release key" } = {}) {
  const key = readSecretKey(pem, passphrase);
  const pk = rawPublicKey(key);
  const id = keyIdOf(pk);
  const digest = createHash("blake2b512").update(data).digest();
  const sig = sign(null, digest, key);
  if (/[\r\n]/.test(trusted)) throw new Error("The trusted comment must be one line.");
  const global = sign(null, Buffer.concat([sig, Buffer.from(trusted, "utf8")]), key);
  return `untrusted comment: ${untrusted}\n${Buffer.concat([Buffer.from("ED"), id, sig]).toString("base64")}\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`;
}

/**
 * Verify a .minisig text for `data` against a public key. Returns the trusted
 * comment; throws with the reason when the signature does not hold.
 */
export function verifyData(data, minisig, publicKeyText) {
  const { id, pk } = parsePublicKey(publicKeyText);
  const lines = String(minisig).split(/\r?\n/);
  if (lines.length < 4 || !lines[0].startsWith("untrusted comment:") || !lines[2].startsWith("trusted comment: ")) throw new Error("Not a minisign signature file.");
  const s = Buffer.from(lines[1], "base64");
  if (s.length !== 74) throw new Error("Malformed signature.");
  const alg = s.subarray(0, 2).toString();
  if (alg !== "ED" && alg !== "Ed") throw new Error(`Unknown signature algorithm "${alg}".`);
  if (!s.subarray(2, 10).equals(id)) throw new Error(`Signed with key ${keyIdHex(s.subarray(2, 10))}, not ${keyIdHex(id)}.`);
  const sig = s.subarray(10);
  const key = keyFromRaw(pk);
  const message = alg === "ED" ? createHash("blake2b512").update(data).digest() : data;
  if (!verify(null, message, key, sig)) throw new Error("The signature does not match the file.");
  const trusted = lines[2].slice("trusted comment: ".length);
  if (!verify(null, Buffer.concat([sig, Buffer.from(trusted, "utf8")]), key, Buffer.from(lines[3], "base64"))) throw new Error("The trusted comment was changed.");
  return trusted;
}
