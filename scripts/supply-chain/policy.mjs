#!/usr/bin/env node
/**
 * The provenance policy (plan W7.22): which build-host keys may sign a
 * release's provenance. Tal signs it on his Mac with a key that is NOT a
 * build key, so a compromised build host cannot vouch for itself.
 *
 *   node scripts/supply-chain/policy.mjs keygen --out ~/.config/lumen-md/policy-ed25519.pem
 *       a new Ed25519 policy key (0600); prints the public half for security/provenance-policy.pub
 *   node scripts/supply-chain/policy.mjs sign --key <policy key> --build-key keys/oracle-a1.pem [--build-key …]
 *       [--builder oracle-a1 …] [--days 365] [--out security/provenance-policy.dsse.json]
 *   node scripts/supply-chain/policy.mjs show [security/provenance-policy.dsse.json]
 */
import { generateKeyPairSync, createPrivateKey, createPublicKey } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { POLICY_PAYLOAD, keyId, makePolicy, signEnvelope } from "./lib.mjs";

const [cmd, ...argv] = process.argv.slice(2);
const all = (name) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1]] : []));
const opt = (name) => all(name)[0];
const die = (m) => {
  console.error(`policy: ${m}`);
  process.exit(2);
};

if (cmd === "keygen") {
  const out = opt("out") ?? die("--out <file>");
  if (existsSync(out)) die(`${out} exists; not replacing a key`);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
  chmodSync(out, 0o600);
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  console.log(`policy key ${keyId(pub).slice(0, 16)} written to ${out} (0600). Its public half, for security/provenance-policy.pub:\n${pub.trim()}`);
} else if (cmd === "sign") {
  const keyFile = opt("key") ?? die("--key <policy private key>");
  const buildKeys = all("build-key").map((f) => createPublicKey(readFileSync(f, "utf8")).export({ type: "spki", format: "pem" }).toString());
  if (!buildKeys.length) die("at least one --build-key <public key of a build host>");
  const priv = readFileSync(keyFile, "utf8");
  const policyPub = createPublicKey(createPrivateKey(priv)).export({ type: "spki", format: "pem" }).toString();
  if (buildKeys.some((k) => keyId(k) === keyId(policyPub))) die("the policy key is one of the build keys: use a separate key (keygen)");
  const days = Number(opt("days") ?? 365);
  const builders = all("builder");
  const policy = makePolicy({ buildKeys, expires: new Date(Date.now() + days * 86400_000).toISOString(), builders: builders.length ? builders : null });
  const out = opt("out") ?? "security/provenance-policy.dsse.json";
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(signEnvelope(POLICY_PAYLOAD, JSON.stringify(policy), priv), null, 2) + "\n");
  console.log(`policy signed by ${keyId(policyPub).slice(0, 16)}: ${buildKeys.length} build key(s), builders ${builders.join(", ") || "any lumen-md host"}, expires ${policy.expires} → ${out}`);
} else if (cmd === "show") {
  const env = JSON.parse(readFileSync(argv[0] ?? "security/provenance-policy.dsse.json", "utf8"));
  console.log(JSON.stringify(JSON.parse(Buffer.from(env.payload, "base64").toString("utf8")), null, 2));
} else {
  console.error("usage: policy.mjs keygen|sign|show (see the header)");
  process.exit(2);
}
