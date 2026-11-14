/**
 * Supply chain without GitHub Actions (plan W7.22): how a release was built
 * (SLSA provenance in an in-toto statement, DSSE-signed by the build host)
 * and who released it (keyless Sigstore: a short-lived Fulcio certificate
 * from Tal's own login, one bundle per file). Pure functions; attest.mjs,
 * policy.mjs and verify.mjs do the I/O.
 *
 * Formats are the standard ones, so other tools read them too:
 *   DSSE        github.com/secure-systems-lab/dsse (PAE, base64 payload)
 *   Statement   https://in-toto.io/Statement/v1
 *   Provenance  https://slsa.dev/provenance/v1
 *   Bundle      Sigstore bundle v0.3 (what `cosign sign-blob --bundle` writes since cosign v3)
 *
 * Two keys, never the same one (the warning in the Witness write-up): the
 * build host's key signs the provenance; the policy, which says which build
 * keys to trust, is signed with Tal's separate policy key.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export const REPO = "talstilkol/lumen-md";
export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const SLSA_PROVENANCE = "https://slsa.dev/provenance/v1";
export const INTOTO_PAYLOAD = "application/vnd.in-toto+json";
export const POLICY_PAYLOAD = "application/vnd.lumen-md.provenance-policy+json";
export const BUILD_TYPE = `https://github.com/${REPO}/blob/main/docs/src/content/docs/security/provenance.md#build-type-v1`;
export const BUILDER_PREFIX = `https://github.com/${REPO}/blob/main/docs/src/content/docs/self-hosting/verification-factory.md#host=`;
/** cosign below this accepts a bundle whose Rekor entry is for another artifact (GHSA-whqx-f9j3-ch6m, fixed in 3.0.4). */
export const COSIGN_MIN = "3.0.4";
/** Files of a release folder that are signatures or attestations, not products. */
export const NOT_SUBJECT = /(^|\/)\.|(\.sigstore\.json|\.minisig|\.sig|\.intoto\.jsonl|\.witness\.json|DRY-RUN\.md|\.FAKE-BUILD)$/;
/** The identity placeholder in security/sigstore-identity.json until Tal fills it in (a check refuses it by name). */
export const IDENTITY_PLACEHOLDER = "${LUMEN_SIGSTORE_IDENTITY}";

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** DSSE's pre-authentication encoding: the bytes that are signed. */
export function pae(payloadType, payload) {
  const t = Buffer.from(payloadType, "utf8");
  const b = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  return Buffer.concat([Buffer.from(`DSSEv1 ${t.length} `), t, Buffer.from(` ${b.length} `), b]);
}

/** keyid = sha256 of the public key's SPKI DER (hex), the way Witness and Sigstore name keys. */
export const keyId = (publicKeyPem) => sha256(createPublicKey(publicKeyPem).export({ type: "spki", format: "der" }));

/** One DSSE envelope; Ed25519 or ECDSA keys (node:crypto picks the algorithm from the key). */
export function signEnvelope(payloadType, payload, privateKeyPem) {
  const key = createPrivateKey(privateKeyPem);
  const pub = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const alg = key.asymmetricKeyType === "ed25519" ? null : "sha256";
  return { payloadType, payload: body.toString("base64"), signatures: [{ keyid: keyId(pub), sig: sign(alg, pae(payloadType, body), key).toString("base64") }] };
}

/**
 * Check an envelope against trusted public keys: at least one signature by
 * one of them, over this exact payload. → { ok, keyid, payload (Buffer), problems }
 */
export function verifyEnvelope(env, trustedPems) {
  const problems = [];
  if (!env || typeof env.payload !== "string" || typeof env.payloadType !== "string" || !Array.isArray(env.signatures)) return { ok: false, problems: ["not a DSSE envelope"] };
  const body = Buffer.from(env.payload, "base64");
  const keys = trustedPems.map((pem) => ({ pem, id: keyId(pem), key: createPublicKey(pem) }));
  for (const s of env.signatures) {
    const k = keys.find((x) => x.id === s.keyid);
    if (!k) continue;
    const alg = k.key.asymmetricKeyType === "ed25519" ? null : "sha256";
    if (verify(alg, pae(env.payloadType, body), k.key, Buffer.from(s.sig ?? "", "base64"))) return { ok: true, keyid: k.id, payload: body, problems };
    problems.push(`signature by ${k.id.slice(0, 16)} does not verify`);
  }
  if (!problems.length) problems.push(`no signature by a trusted key (signed by ${env.signatures.map((s) => String(s.keyid).slice(0, 16)).join(", ") || "nobody"})`);
  return { ok: false, keyid: null, payload: body, problems };
}

/** [{ name, sha256 }] → in-toto subjects, sorted by code point (not localeCompare: the order must not depend on the machine's locale). */
export const subjects = (files) => [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((f) => ({ name: f.name, digest: { sha256: f.sha256 } }));

/**
 * The SLSA v1 provenance statement of one release build.
 * @param {{ files: {name: string, sha256: string}[], command: string[], source: { commit: string, ref?: string, dirty: boolean }, lockfiles: {name: string, sha256: string}[], host: string, startedOn: string, finishedOn: string, invocationId: string, environment?: object, byproducts?: {name: string, sha256: string}[] }} b
 */
export function provenanceStatement(b) {
  return {
    _type: STATEMENT_TYPE,
    subject: subjects(b.files),
    predicateType: SLSA_PROVENANCE,
    predicate: {
      buildDefinition: {
        buildType: BUILD_TYPE,
        externalParameters: {
          command: b.command,
          source: { uri: `git+https://github.com/${REPO}`, ref: b.source.ref ?? null, digest: { gitCommit: b.source.commit } },
        },
        internalParameters: { dirtyTree: b.source.dirty, ...(b.environment ?? {}) },
        resolvedDependencies: [
          { uri: `git+https://github.com/${REPO}`, digest: { gitCommit: b.source.commit } },
          ...b.lockfiles.map((l) => ({ name: l.name, digest: { sha256: l.sha256 } })),
        ],
      },
      runDetails: {
        builder: { id: `${BUILDER_PREFIX}${b.host}` },
        metadata: { invocationId: b.invocationId, startedOn: b.startedOn, finishedOn: b.finishedOn },
        byproducts: (b.byproducts ?? []).map((x) => ({ name: x.name, digest: { sha256: x.sha256 } })),
      },
    },
  };
}

/**
 * The policy: which build keys may sign provenance, for which builder and
 * source, and until when. Signed with the policy key (policy.mjs).
 */
export function makePolicy({ buildKeys, expires, builders = null, requireCleanTree = true }) {
  return {
    version: 1,
    expires,
    repo: `git+https://github.com/${REPO}`,
    predicateType: SLSA_PROVENANCE,
    buildType: BUILD_TYPE,
    builderPrefix: BUILDER_PREFIX,
    builders,
    requireCleanTree,
    functionaries: buildKeys.map((pem) => ({ keyid: keyId(pem), publicKey: pem.trim() })),
  };
}

/**
 * Verify one product against the provenance and the signed policy.
 * @param {{ policyEnvelope: object, policyKeyPem: string, provenanceEnvelope: object, file: { name: string, sha256: string }, now?: Date, commit?: string }} a
 * → { ok, problems, statement }
 */
export function verifyProvenance({ policyEnvelope, policyKeyPem, provenanceEnvelope, file, now = new Date(), commit = null }) {
  const problems = [];
  const pol = verifyEnvelope(policyEnvelope, [policyKeyPem]);
  if (!pol.ok || policyEnvelope.payloadType !== POLICY_PAYLOAD) return { ok: false, problems: [`policy: ${pol.ok ? `payload type ${policyEnvelope.payloadType}` : pol.problems.join("; ")}`], statement: null };
  let policy;
  try {
    policy = JSON.parse(pol.payload.toString("utf8"));
  } catch {
    return { ok: false, problems: ["policy: not JSON"], statement: null };
  }
  if (!policy.expires || Date.parse(policy.expires) < now.getTime()) problems.push(`policy expired on ${policy.expires}`);
  const policyKeyId = keyId(policyKeyPem);
  const functionaries = (policy.functionaries ?? []).filter((f) => f.keyid !== policyKeyId);
  if (functionaries.length < (policy.functionaries ?? []).length) problems.push("the policy key is also a build key: a build host could then sign its own policy");
  const prov = verifyEnvelope(provenanceEnvelope, functionaries.map((f) => f.publicKey));
  if (!prov.ok) return { ok: false, problems: [...problems, `provenance: ${prov.problems.join("; ")}`], statement: null };
  if (provenanceEnvelope.payloadType !== INTOTO_PAYLOAD) problems.push(`provenance payload type is ${provenanceEnvelope.payloadType}`);
  let st;
  try {
    st = JSON.parse(prov.payload.toString("utf8"));
  } catch {
    return { ok: false, problems: [...problems, "provenance: not JSON"], statement: null };
  }
  if (st._type !== STATEMENT_TYPE) problems.push(`statement type ${st._type}`);
  if (st.predicateType !== policy.predicateType) problems.push(`predicate ${st.predicateType}, the policy wants ${policy.predicateType}`);
  const p = st.predicate ?? {};
  if (p.buildDefinition?.buildType !== policy.buildType) problems.push(`build type ${p.buildDefinition?.buildType}`);
  const builder = p.runDetails?.builder?.id ?? "";
  if (!builder.startsWith(policy.builderPrefix)) problems.push(`builder ${builder} is not a lumen-md build host`);
  if (policy.builders && !policy.builders.includes(builder.slice(policy.builderPrefix.length))) problems.push(`builder ${builder} is not one the policy names`);
  const src = p.buildDefinition?.externalParameters?.source ?? {};
  if (src.uri !== policy.repo) problems.push(`source ${src.uri}, the policy wants ${policy.repo}`);
  if (commit && src.digest?.gitCommit !== commit) problems.push(`built from ${src.digest?.gitCommit}, expected ${commit}`);
  if (policy.requireCleanTree && p.buildDefinition?.internalParameters?.dirtyTree !== false) problems.push("built from a working tree with uncommitted changes");
  const subj = (st.subject ?? []).find((s) => s.name === file.name);
  if (!subj) problems.push(`${file.name} is not a subject of the provenance`);
  else if (subj.digest?.sha256 !== file.sha256) problems.push(`${file.name}: sha256 ${file.sha256} differs from the provenance's ${subj.digest?.sha256}`);
  return { ok: problems.length === 0, problems, statement: st };
}

/** security/sigstore-identity.json → problems (an unfilled placeholder is refused by name). */
export function identityProblems(id) {
  const out = [];
  if (!id?.identity || id.identity === IDENTITY_PLACEHOLDER) out.push(`security/sigstore-identity.json: "identity" is still ${IDENTITY_PLACEHOLDER}; Tal fills in the email his Sigstore login shows`);
  if (!/^https:\/\//.test(id?.issuer ?? "")) out.push('security/sigstore-identity.json: "issuer" must be the OIDC issuer URL (e.g. https://github.com/login/oauth)');
  return out;
}

/** `cosign version` output → "3.0.5", or null. */
export function cosignVersion(text) {
  const m = /GitVersion:\s*v?(\d+\.\d+\.\d+)/.exec(String(text)) ?? /\bv?(\d+\.\d+\.\d+)\b/.exec(String(text));
  return m ? m[1] : null;
}
export const versionAtLeast = (v, min) => {
  const a = String(v).split(".").map(Number);
  const b = String(min).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

/** The cosign commands (argv) for one file: keyless signing on the Mac, and the check anyone runs. */
export const cosignSignArgs = (file) => ["sign-blob", "--yes", "--bundle", `${file}.sigstore.json`, file];
export const cosignVerifyArgs = (file, { identity, issuer }, { trustedRoot = null } = {}) => ["verify-blob", file, "--bundle", `${file}.sigstore.json`, "--certificate-identity", identity, "--certificate-oidc-issuer", issuer, ...(trustedRoot ? ["--trusted-root", trustedRoot, "--offline"] : [])];

/** `witness run` for the release build on the host (when Witness is installed): SLSA attestor, products from the release folder. */
export const witnessRunArgs = ({ key, out, productGlob, command }) => ["run", "--step", "build", "-a", "slsa,git,environment", "--attestor-slsa-export", "--attestor-product-include-glob", productGlob, "-k", key, "-o", out, "--", ...command];
export const witnessVerifyArgs = ({ policy, policyKey, attestation, file }) => ["verify", "-p", policy, "-k", policyKey, "-a", attestation, "-f", file];

/** The SLSA Build L2 requirements and where this repository meets each (docs/…/provenance.md renders the same table). */
export const SLSA_L2 = [
  { id: "Provenance exists (L1)", how: "attest.mjs writes release/provenance.intoto.jsonl: an in-toto Statement v1 with a SLSA v1 predicate, one subject per release file", evidence: "verify.mjs; supplyChain test 'provenance names every file'" },
  { id: "Provenance is complete: build type, external parameters, resolved dependencies, builder id", how: "buildType, the command, the source commit, package-lock.json and Cargo.lock digests, builder id = the host", evidence: "provenanceStatement(); the policy checks buildType, builder and source" },
  { id: "Hosted build platform (L2)", how: "the release builds on the factory's second host (W6.5), not on a developer's laptop; the builder id names the host", evidence: "policy.builders; a provenance from another builder fails" },
  { id: "Provenance is authentic (L2): signed by the build platform, verifiable by consumers", how: "DSSE, Ed25519 key that lives only on the host (0600, the factory's key); the policy that trusts it is signed with a different key", evidence: "verify.mjs fails on another key, on a changed byte, and when the policy key is also a build key" },
  { id: "Provenance is distributed", how: "provenance.intoto.jsonl and a Sigstore bundle per file are release assets; the download page shows the verify commands", evidence: "the release folder; docs/security/provenance" },
  { id: "Release identity (beyond SLSA)", how: "keyless Sigstore: Tal signs each file from his own login; the certificate's identity and OIDC issuer are pinned in security/sigstore-identity.json", evidence: "cosign verify-blob --certificate-identity … --certificate-oidc-issuer …; verify.mjs" },
];
