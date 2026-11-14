#!/usr/bin/env node
/**
 * Check a lumen-md release before you trust it (plan W7.22). Users run it on
 * a download, and the release gate runs it on every file before anything is
 * published (so the updater's latest.json only ever names checked files).
 *
 *   node scripts/supply-chain/verify.mjs release/                 every file in the folder
 *   node scripts/supply-chain/verify.mjs Lumen_0.2.0_aarch64.dmg  one file (its bundle and the provenance next to it)
 *
 * For each file, two independent checks, both must pass:
 *   1. How it was built: release/provenance.intoto.jsonl (SLSA v1, DSSE) is signed
 *      by a build key that the provenance policy trusts, the policy is signed by
 *      the policy key (security/provenance-policy.pub), and the file's sha256 is a
 *      subject. Also: the lumen-md source, a clean tree, a lumen-md build host.
 *   2. Who released it: <file>.sigstore.json is a Sigstore bundle whose
 *      certificate names the identity and OIDC issuer in security/sigstore-identity.json,
 *      logged in Rekor, over this exact file. Checked with cosign ≥ 3.0.4 when it is
 *      installed, else with the sigstore-js that ships inside npm (every Node install has it).
 *
 * Options:
 *   --trusted-root <trusted_root.json>  Sigstore's trust root from a file: no network (cosign --offline)
 *   --policy <file> --policy-key <pem>  default security/provenance-policy.dsse.json and .pub
 *   --identity <file>                   default security/sigstore-identity.json
 *   --commit <sha>                      the release's commit (the tag), when known
 *   --with cosign|sigstore-js           force one Sigstore verifier
 * Environment: LUMEN_SIGSTORE_TRUSTED_ROOT and LUMEN_SIGSTORE_WITH stand for the two options (sign.sh passes them on).
 *   --witness                           also run `witness verify` on provenance.witness.json (must pass)
 * Exit 0 when every file passes both checks, 1 otherwise, 2 on a usage error.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COSIGN_MIN, NOT_SUBJECT, cosignVerifyArgs, cosignVersion, identityProblems, sha256, verifyProvenance, versionAtLeast, witnessVerifyArgs } from "./lib.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const valued = new Set(["trusted-root", "policy", "policy-key", "identity", "commit", "with"]);
const targets = argv.filter((a, i) => !a.startsWith("--") && !valued.has(String(argv[i - 1]).replace(/^--/, "")));
if (!targets.length) {
  console.error("usage: verify.mjs <release folder | file …> (see the header)");
  process.exit(2);
}
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
const policyFile = opt("policy") ?? join(root, "security/provenance-policy.dsse.json");
const policyKeyFile = opt("policy-key") ?? join(root, "security/provenance-policy.pub");
const identityFile = opt("identity") ?? join(root, "security/sigstore-identity.json");
const trustedRoot = opt("trusted-root") ?? (process.env.LUMEN_SIGSTORE_TRUSTED_ROOT || null);
for (const [what, f] of [["policy", policyFile], ["policy key", policyKeyFile], ["Sigstore identity", identityFile], ...(trustedRoot ? [["trusted root", trustedRoot]] : [])])
  if (!existsSync(f)) {
    console.error(`verify: no ${what} at ${f}`);
    process.exit(2);
  }
const identity = readJson(identityFile);
const idProblems = identityProblems(identity);
if (idProblems.length) {
  for (const p of idProblems) console.error(`✗ ${p}`);
  process.exit(1);
}

/** Files to check: a folder's products (not signatures, bundles or attestations' own logs) or the files given. */
function filesOf(t) {
  const p = resolve(t);
  if (!statSync(p).isDirectory()) return [{ path: p, dir: dirname(p), name: basename(p) }];
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const f = join(d, n);
      if (statSync(f).isDirectory()) walk(f);
      else {
        const rel = relative(p, f).split("\\").join("/");
        if (!NOT_SUBJECT.test(rel) && rel !== "build.log") out.push({ path: f, dir: p, name: rel });
      }
    }
  };
  walk(p);
  // The provenance is signed by Tal too: its own bundle is checked like any file's.
  if (existsSync(join(p, "provenance.intoto.jsonl"))) out.push({ path: join(p, "provenance.intoto.jsonl"), dir: p, name: "provenance.intoto.jsonl", provenanceItself: true });
  return out;
}

// ── Sigstore: cosign, else npm's own sigstore-js ───────────────────────────
function cosign() {
  const r = spawnSync("cosign", ["version"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const v = cosignVersion(`${r.stdout}${r.stderr}`);
  return v && versionAtLeast(v, COSIGN_MIN) ? v : { tooOld: v };
}
function sigstoreJs() {
  const candidates = [
    join(root, "node_modules/sigstore/package.json"),
    join(dirname(process.execPath), "../lib/node_modules/npm/node_modules/sigstore/package.json"),
    join(dirname(process.execPath), "node_modules/npm/node_modules/sigstore/package.json"),
  ];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    const req = createRequire(c);
    try {
      return { version: readJson(c).version, verify: req("@sigstore/verify"), bundle: req("@sigstore/bundle"), specs: req("@sigstore/protobuf-specs"), tuf: req("@sigstore/tuf") };
    } catch {
      // why: an npm without the verifier inside; try the next place
    }
  }
  return null;
}
const want = opt("with") ?? (process.env.LUMEN_SIGSTORE_WITH || undefined);
const cos = want === "sigstore-js" ? null : cosign();
if (cos && typeof cos === "object") console.error(`verify: cosign ${cos.tooOld} is older than ${COSIGN_MIN} (GHSA-whqx-f9j3-ch6m); using sigstore-js instead`);
const useCosign = typeof cos === "string" && want !== "sigstore-js";
if (want === "cosign" && !useCosign) {
  console.error(`verify: --with cosign, but cosign ≥ ${COSIGN_MIN} is not installed`);
  process.exit(2);
}
const sjs = useCosign ? null : sigstoreJs();
if (!useCosign && !sjs) {
  console.error("verify: neither cosign nor npm's sigstore-js is available: install cosign (docs: security/supply-chain)");
  process.exit(2);
}
let verifier = null;
async function sigstoreVerifier() {
  if (verifier) return verifier;
  const root2 = trustedRoot ? sjs.specs.TrustedRoot.fromJSON(readJson(trustedRoot)) : await sjs.tuf.getTrustedRoot({});
  // The defaults: one transparency-log entry and one SCT required, as cosign does.
  verifier = new sjs.verify.Verifier(sjs.verify.toTrustMaterial(root2));
  return verifier;
}
async function checkBundle(file) {
  const b = `${file}.sigstore.json`;
  if (!existsSync(b)) return `no Sigstore bundle ${basename(b)}`;
  if (useCosign) {
    const r = spawnSync("cosign", cosignVerifyArgs(file, identity, { trustedRoot }), { encoding: "utf8" });
    return r.status === 0 ? null : `cosign verify-blob: ${(r.stderr || r.stdout).trim().split("\n").pop()}`;
  }
  try {
    const v = await sigstoreVerifier();
    const entity = sjs.verify.toSignedEntity(sjs.bundle.bundleFromJSON(readJson(b)), readFileSync(file));
    v.verify(entity, { subjectAlternativeName: identity.identity, extensions: { issuer: identity.issuer } });
    return null;
  } catch (e) {
    return `Sigstore: ${e.code ? `${e.code}: ` : ""}${e.message}`;
  }
}

// ── run ────────────────────────────────────────────────────────────────────
const policyEnvelope = readJson(policyFile);
const policyKeyPem = readFileSync(policyKeyFile, "utf8");
let bad = 0;
let n = 0;
console.log(`verify: build provenance against ${relative(process.cwd(), policyFile)}; release identity ${identity.identity} (${identity.issuer}) with ${useCosign ? `cosign ${cos}` : `sigstore-js ${sjs.version} (npm's)`}${trustedRoot ? ", trust root from a file (offline)" : ", trust root from Sigstore's TUF"}`);
for (const t of targets) {
  for (const f of filesOf(t)) {
    n++;
    const problems = [];
    const provFile = join(f.dir, "provenance.intoto.jsonl");
    if (!f.provenanceItself) {
      if (!existsSync(provFile)) problems.push("no provenance.intoto.jsonl next to it");
      else {
        const first = readFileSync(provFile, "utf8").split("\n").find((l) => l.trim());
        const r = verifyProvenance({ policyEnvelope, policyKeyPem, provenanceEnvelope: JSON.parse(first ?? "{}"), file: { name: f.name, sha256: sha256(readFileSync(f.path)) }, commit: opt("commit") ?? null });
        problems.push(...r.problems.map((p) => `provenance: ${p}`));
      }
    }
    const s = await checkBundle(f.path);
    if (s) problems.push(s);
    if (argv.includes("--witness") && !f.provenanceItself) {
      const att = join(f.dir, "provenance.witness.json");
      const wp = join(root, "security/witness-policy.signed.json");
      if (!existsSync(att) || !existsSync(wp)) problems.push("witness: provenance.witness.json or security/witness-policy.signed.json is missing");
      else {
        const r = spawnSync("witness", witnessVerifyArgs({ policy: wp, policyKey: policyKeyFile, attestation: att, file: f.path }), { encoding: "utf8" });
        if (r.status !== 0) problems.push(`witness verify: ${(r.stderr || r.stdout || "not installed").trim().split("\n").pop()}`);
      }
    }
    if (problems.length) {
      bad++;
      console.log(`✗ ${f.name}`);
      for (const p of problems) console.log(`    ${p}`);
    } else console.log(`✓ ${f.name}`);
  }
}
console.log(bad ? `✗ ${bad} of ${n} file(s) failed` : `✓ all ${n} file(s): built by a trusted host from lumen-md, released by ${identity.identity}`);
process.exit(bad ? 1 : 0);
