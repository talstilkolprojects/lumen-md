// @vitest-environment node
import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  COSIGN_MIN,
  IDENTITY_PLACEHOLDER,
  INTOTO_PAYLOAD,
  NOT_SUBJECT,
  POLICY_PAYLOAD,
  SLSA_L2,
  cosignSignArgs,
  cosignVerifyArgs,
  cosignVersion,
  identityProblems,
  keyId,
  makePolicy,
  pae,
  provenanceStatement,
  signEnvelope,
  verifyEnvelope,
  verifyProvenance,
  versionAtLeast,
  witnessRunArgs,
  // @ts-expect-error — plain .mjs module without type declarations
} from "../../scripts/supply-chain/lib.mjs";

type Pair = { priv: string; pub: string };
const ed = (): Pair => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), pub: publicKey.export({ type: "spki", format: "pem" }).toString() };
};
const sha = (c: string) => c.repeat(64);
const commit = "c".repeat(40);
const build = (over: Partial<{ host: string; dirty: boolean; files: { name: string; sha256: string }[] }> = {}) =>
  provenanceStatement({
    files: over.files ?? [{ name: "lumen-web-v1.tgz", sha256: sha("a") }, { name: "SHA256SUMS", sha256: sha("b") }],
    command: ["npm", "run", "release", "--", "0.2.0-beta.1"],
    source: { commit, ref: "refs/heads/main", dirty: over.dirty ?? false },
    lockfiles: [{ name: "package-lock.json", sha256: sha("d") }],
    host: over.host ?? "oracle-a1",
    startedOn: "2026-11-14T10:00:00Z",
    finishedOn: "2026-11-14T10:20:00Z",
    invocationId: "urn:uuid:1",
  });

describe("DSSE and in-toto (plan W7.22)", () => {
  it("PAE matches the DSSE specification's example", () => {
    expect(pae("http://example.com/HelloWorld", "hello world").toString()).toBe("DSSEv1 29 http://example.com/HelloWorld 11 hello world");
  });

  it("signs and verifies an envelope; another key or a changed payload fails", () => {
    const k = ed();
    const env = signEnvelope(INTOTO_PAYLOAD, "{}", k.priv);
    expect(env.signatures[0].keyid).toBe(keyId(k.pub));
    expect(verifyEnvelope(env, [k.pub]).ok).toBe(true);
    expect(verifyEnvelope(env, [ed().pub]).ok).toBe(false);
    expect(verifyEnvelope({ ...env, payload: Buffer.from("{ }").toString("base64") }, [k.pub]).ok).toBe(false);
  });

  it("the provenance is a SLSA v1 statement naming every file, the source commit and the lockfile", () => {
    const st = build();
    expect(st._type).toBe("https://in-toto.io/Statement/v1");
    expect(st.predicateType).toBe("https://slsa.dev/provenance/v1");
    expect(st.subject.map((s: { name: string }) => s.name)).toEqual(["SHA256SUMS", "lumen-web-v1.tgz"]);
    expect(st.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit).toBe(commit);
    expect(st.predicate.runDetails.builder.id).toMatch(/#host=oracle-a1$/);
  });
});

describe("verifying provenance against the signed policy", () => {
  const policyKey = ed();
  const buildKey = ed();
  const policy = (keys = [buildKey.pub], expires = "2099-01-01T00:00:00Z") => signEnvelope(POLICY_PAYLOAD, JSON.stringify(makePolicy({ buildKeys: keys, expires, builders: ["oracle-a1"] })), policyKey.priv);
  const prov = (st = build(), key = buildKey) => signEnvelope(INTOTO_PAYLOAD, JSON.stringify(st), key.priv);
  const file = { name: "lumen-web-v1.tgz", sha256: sha("a") };
  const run = (a: Partial<Record<string, unknown>> = {}) => verifyProvenance({ policyEnvelope: policy(), policyKeyPem: policyKey.pub, provenanceEnvelope: prov(), file, ...a });

  it("passes for a file the trusted host built from a clean lumen-md tree", () => {
    expect(run().problems).toEqual([]);
    expect(run({ commit }).ok).toBe(true);
  });

  it("fails on a changed byte, an unknown file, another commit", () => {
    expect(run({ file: { ...file, sha256: sha("e") } }).problems.join()).toContain("differs from the provenance");
    expect(run({ file: { name: "x.dmg", sha256: sha("a") } }).problems.join()).toContain("not a subject");
    expect(run({ commit: "d".repeat(40) }).ok).toBe(false);
  });

  it("fails on an untrusted build key, a policy under another key, an expired policy", () => {
    expect(run({ provenanceEnvelope: prov(build(), ed()) }).problems.join()).toContain("no signature by a trusted key");
    expect(run({ policyKeyPem: ed().pub }).problems.join()).toContain("policy:");
    expect(run({ policyEnvelope: policy([buildKey.pub], "2020-01-01T00:00:00Z") }).problems.join()).toContain("expired");
  });

  it("a policy key that is also a build key is refused (the host could vouch for itself)", () => {
    const own = signEnvelope(POLICY_PAYLOAD, JSON.stringify(makePolicy({ buildKeys: [policyKey.pub], expires: "2099-01-01T00:00:00Z" })), policyKey.priv);
    const r = verifyProvenance({ policyEnvelope: own, policyKeyPem: policyKey.pub, provenanceEnvelope: prov(build(), policyKey), file });
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toContain("the policy key is also a build key");
  });

  it("a dirty tree or a builder the policy does not name is refused", () => {
    expect(run({ provenanceEnvelope: prov(build({ dirty: true })) }).problems.join()).toContain("uncommitted changes");
    expect(run({ provenanceEnvelope: prov(build({ host: "laptop" })) }).problems.join()).toContain("not one the policy names");
  });
});

describe("Sigstore identity and tools", () => {
  it("refuses the identity placeholder and a non-URL issuer", () => {
    expect(identityProblems({ identity: IDENTITY_PLACEHOLDER, issuer: "https://github.com/login/oauth" }).join()).toContain(IDENTITY_PLACEHOLDER);
    expect(identityProblems({ identity: "a@example.com", issuer: "github" })).toHaveLength(1);
    expect(identityProblems({ identity: "a@example.com", issuer: "https://github.com/login/oauth" })).toEqual([]);
  });

  it("needs cosign ≥ 3.0.4 (GHSA-whqx-f9j3-ch6m)", () => {
    expect(cosignVersion("GitVersion:    v3.0.5\nGitCommit: x")).toBe("3.0.5");
    expect(versionAtLeast("3.0.5", COSIGN_MIN)).toBe(true);
    expect(versionAtLeast("3.0.3", COSIGN_MIN)).toBe(false);
    expect(versionAtLeast("2.6.2", COSIGN_MIN)).toBe(false);
  });

  it("builds the cosign and witness command lines", () => {
    expect(cosignSignArgs("a.dmg")).toEqual(["sign-blob", "--yes", "--bundle", "a.dmg.sigstore.json", "a.dmg"]);
    expect(cosignVerifyArgs("a.dmg", { identity: "t@example.com", issuer: "https://github.com/login/oauth" })).toEqual(["verify-blob", "a.dmg", "--bundle", "a.dmg.sigstore.json", "--certificate-identity", "t@example.com", "--certificate-oidc-issuer", "https://github.com/login/oauth"]);
    expect(witnessRunArgs({ key: "k.pem", out: "o.json", productGlob: "release/*", command: ["npm", "run", "x"] }).slice(0, 4)).toEqual(["run", "--step", "build", "-a"]);
  });

  it("signatures and attestations are not release subjects", () => {
    for (const f of ["a.dmg.sigstore.json", "SHA256SUMS.minisig", "x.sig", "provenance.intoto.jsonl", "provenance.witness.json"]) expect(NOT_SUBJECT.test(f)).toBe(true);
    for (const f of ["a.dmg", "SHA256SUMS", "sbom.cdx.json", "latest.json"]) expect(NOT_SUBJECT.test(f)).toBe(false);
  });

  it("maps SLSA Build L2 requirement by requirement, each with evidence", () => {
    expect(SLSA_L2.length).toBeGreaterThanOrEqual(5);
    for (const r of SLSA_L2 as { id: string; how: string; evidence: string }[]) expect(r.how.length && r.evidence.length).toBeTruthy();
  });
});
