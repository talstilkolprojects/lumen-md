---
title: Supply chain: how a release was built, and who released it
description: Every lumen-md release file carries SLSA provenance signed by the build host and a keyless Sigstore signature from Tal's own login. One command checks both, offline if you like.
---

A minisign signature (W1.27) proves which key signed a file. It doesn't say
how the file was built. Plan W7.22 adds two independent proofs to every
release file, without GitHub Actions:

1. **How it was built.** `provenance.intoto.jsonl` is an in-toto Statement
   v1 with a SLSA v1 provenance predicate:
   - every release file and its sha256
   - the lumen-md commit it was built from, and whether the tree was clean
   - the digests of `package-lock.json` and `Cargo.lock`
   - the command, the build host, the start and end times

   The build host signs it (DSSE, Ed25519). A **policy** says which host keys
   to trust, and Tal signs the policy with a different key. A compromised
   build host therefore can't vouch for itself.
2. **Who released it.** Each file has `<file>.sigstore.json`, a keyless
   Sigstore bundle. Tal signs from his own login in the browser, and Fulcio
   issues a 10-minute certificate for that identity. The signature is
   recorded in Rekor, Sigstore's public transparency log. No long-lived
   private key exists that could leak.

## Check a download

With [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) (3.0.4 or newer):

```bash
cosign verify-blob Lumen_0.2.0-beta.1_aarch64.dmg \
  --bundle Lumen_0.2.0-beta.1_aarch64.dmg.sigstore.json \
  --certificate-identity <the identity in security/sigstore-identity.json> \
  --certificate-oidc-issuer https://github.com/login/oauth
```

With Node (any install: it uses the Sigstore verifier that ships inside npm).
It checks both proofs, for one file or for a whole download folder:

```bash
node scripts/supply-chain/verify.mjs ~/Downloads/lumen-0.2.0-beta.1/
```

The checker exits with a non-zero code if any byte of any file changed. It
also refuses:

- a signature by another identity, or a bundle copied from another file
- a provenance signed by a key the policy doesn't trust, or a policy signed by another key
- a build from a tree with uncommitted changes, or from a host the policy doesn't name

**Without network:** pass `--trusted-root trusted_root.json`. That file is
Sigstore's trust root, saved earlier with `cosign trusted-root create` or by
an earlier online check. cosign then runs with `--offline`.

cosign older than 3.0.4 is refused: it could accept a bundle whose Rekor
entry belongs to another artifact
([GHSA-whqx-f9j3-ch6m](https://osv.dev/GHSA-whqx-f9j3-ch6m)).

## How a release is made

1. **On the build host** (the verification factory's machine, W6.5): the
   release builds under `attest.mjs`.
   - It writes the provenance and signs it with the host's key, which never
     leaves that machine.
   - When [Witness](https://witness.dev) is installed
     (`scripts/supply-chain/install-tools.sh`, pinned versions checked against
     their release checksums), the build also runs under
     `witness run --step build -a slsa`. Witness's own attestation is kept for
     `witness verify` (`verify.mjs --witness`).

   ```bash
   node scripts/supply-chain/attest.mjs --out release -- <the release build: W4.5's release command, #492>
   ```
2. **On Tal's Mac:** `bash scripts/supply-chain/sign.sh release/`.
   - One browser login per file. A bundle per file, the provenance included.
   - Then `verify.mjs` checks the whole folder.
3. **The release gate.** `verify.mjs release/ --commit <the tag's commit>` must
   exit 0 before anything is published. The updater's `latest.json` therefore
   only ever names files that passed both checks. The desktop updater keeps its
   own minisign check (W4.5).

The npm package of the plugin SDK is published by hand with the same two
files. npm's own trusted publishing and automatic provenance work only from
GitHub Actions, GitLab and CircleCI's cloud runners, not from our own machine
([npm: trusted publishers](https://docs.npmjs.com/trusted-publishers)).

### Build type v1

`buildType` in the provenance is this section's address. Its parameters:

- `externalParameters.command`: the release command
- `externalParameters.source`: the repository and its commit
- `internalParameters`: Node's version, the platform and whether the tree was dirty
- `resolvedDependencies`: the commit, then the lockfiles' sha256
- `byproducts`: the build log's sha256

## SLSA Build L2, requirement by requirement

| Requirement | How lumen-md meets it | Evidence |
|---|---|---|
| Provenance exists (L1) | `attest.mjs` writes an in-toto Statement v1 with a SLSA v1 predicate, one subject per file | `verify.mjs`; `supplyChainProvenance.test.ts` |
| Provenance is complete | build type, the command, the source commit, the lockfile digests, the builder | the policy checks build type, builder and source |
| A hosted build platform (L2) | the release builds on the factory host, not on a laptop; the builder id names the host | a build from a host the policy doesn't name fails |
| Provenance is authentic (L2) | DSSE signed by the host's key (0600, on the host only); the policy that trusts it is signed by a different key | `verify.mjs` fails on another key, a changed byte, and a policy key that is also a build key |
| Provenance is distributed | the provenance and the bundles are release assets; this page shows the commands | the release folder |
| Release identity (beyond SLSA) | keyless Sigstore from Tal's login; identity and issuer pinned in `security/sigstore-identity.json` | `cosign verify-blob --certificate-identity … --certificate-oidc-issuer …` |

## Owner setup (once)

1. **The policy key** on the Mac. Commit the public half as `security/provenance-policy.pub`:

   ```bash
   node scripts/supply-chain/policy.mjs keygen --out ~/.config/lumen-md/policy-ed25519.pem
   ```
2. **The policy**, signed on the Mac with the build host's public key. The factory
   commits it as `keys/oracle-a1.pem` in `lumen-md-receipts`. Commit the
   policy as `security/provenance-policy.dsse.json`, and sign it again before
   it expires (365 days):

   ```bash
   node scripts/supply-chain/policy.mjs sign --key ~/.config/lumen-md/policy-ed25519.pem --build-key oracle-a1.pem --builder oracle-a1
   ```
3. **The identity.** Run `brew install cosign`, then sign one test file with
   `cosign sign-blob --bundle t.sigstore.json t`. Write the email the login
   shows into `security/sigstore-identity.json` ("identity"). Until then,
   `verify.mjs` and `sign.sh` refuse to run and name the placeholder.
4. **On the build host:** `sudo bash scripts/supply-chain/install-tools.sh`. Record
   the sha256 values it prints in the PR.

## Tested offline

`npm run supply:selftest` runs the whole chain on this machine:

- the policy, and the build under `attest.mjs`
- signing through `sign.sh`
- 11 cases that must fail, 9 of them in `verify.mjs`

The Sigstore check is the real one, `@sigstore/verify` from npm. It checks:

- the certificate chain and the embedded SCT
- Rekor's inclusion promise, and the inclusion proof with its signed checkpoint
- the signature and the identity

Sigstore's services are played by `sigstore-local.mjs` with test keys. Witness
and a real Fulcio login run first on the real host and Mac.
