#!/usr/bin/env bash
# The whole release supply chain offline (plan W7.22): `bash scripts/supply-chain/selftest.sh`
# (npm run supply:selftest).
#
# Real here: node:crypto (Ed25519, ECDSA P-256), git, the scripts themselves,
# and the Sigstore verifier: sigstore-js from inside npm (@sigstore/verify),
# the code `npm audit signatures` uses. It checks the certificate chain, the
# embedded SCT, Rekor's inclusion promise and inclusion proof with its signed
# checkpoint, the signature over the file and the identity policy.
# A stand-in: Sigstore's public services. sigstore-local.mjs plays Fulcio, the
# CT log and Rekor with local test keys and writes a trusted_root.json, so the
# verifier runs against test roots instead of Sigstore's. `cosign` is a fake that
# signs through the same stand-in, and records how verify.mjs would call the real one.
# Not run: Witness, a real cosign, Fulcio/Rekor, a browser login.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; TOOL="$(cd "$HERE/../.." && pwd)"
T="$(mktemp -d)"; if [ -n "${LUMEN_SELFTEST_KEEP:-}" ]; then echo "(keeping $T)"; else trap 'rm -rf "$T"' EXIT; fi
pass=0; fail=0
ok() { echo "  ✓ $1"; pass=$((pass + 1)); }
no() { echo "  ✗ $1"; fail=$((fail + 1)); }
expect() { if eval "$2"; then ok "$1"; else no "$1"; fi; }
G=(git -c user.name=t -c user.email=t@example.com -c init.defaultBranch=main -c core.hooksPath=/dev/null)

# ── a lumen-md stand-in with this branch's scripts, test keys and a test identity ──
R="$T/repo"; mkdir -p "$R/scripts" "$R/security" "$T/keys"
cp -r "$TOOL/scripts/supply-chain" "$R/scripts/"
echo '{"lockfileVersion":3}' > "$R/package-lock.json"
echo '{"identity":"tal@example.com","issuer":"https://github.com/login/oauth"}' > "$R/security/sigstore-identity.json"
( cd "$R" && "${G[@]}" init -q && "${G[@]}" add . && "${G[@]}" commit -qm "stand-in" )
COMMIT="$(git -C "$R" rev-parse HEAD)"
newkey() { node -e 'const c=require("crypto"),fs=require("fs");const {privateKey,publicKey}=c.generateKeyPairSync("ed25519");fs.writeFileSync(process.argv[1]+".pem",privateKey.export({type:"pkcs8",format:"pem"}),{mode:0o600});fs.writeFileSync(process.argv[1]+".pub",publicKey.export({type:"spki",format:"pem"}))' "$1"; }
newkey "$T/keys/build"; newkey "$T/keys/other"
echo "1. the policy (Tal's key, not the build host's)"
node "$R/scripts/supply-chain/policy.mjs" keygen --out "$T/keys/policy.pem" > "$T/keygen.log"
expect "keygen: a new Ed25519 policy key, mode 0600" '[ "$(stat -c %a "$T/keys/policy.pem")" = 600 ] && grep -q "BEGIN PUBLIC KEY" "$T/keygen.log"'
sed -n '/BEGIN PUBLIC KEY/,/END PUBLIC KEY/p' "$T/keygen.log" > "$R/security/provenance-policy.pub"
code=0; node "$R/scripts/supply-chain/policy.mjs" sign --key "$T/keys/build.pem" --build-key "$T/keys/build.pub" --out "$T/bad-policy.json" > /dev/null 2>&1 || code=$?
expect "the policy cannot be signed with a build key" '[ $code = 2 ] && [ ! -f "$T/bad-policy.json" ]'
( cd "$R" && node scripts/supply-chain/policy.mjs sign --key "$T/keys/policy.pem" --build-key "$T/keys/build.pub" --builder oracle-a1 --out security/provenance-policy.dsse.json > /dev/null )
expect "policy signed: one build key, builder oracle-a1" 'node "$R/scripts/supply-chain/policy.mjs" show "$R/security/provenance-policy.dsse.json" | grep -q "\"oracle-a1\""'

echo "2. the release build under attest.mjs (the build host)"
cat > "$R/build.sh" <<'EOF'
mkdir -p release
printf 'the web app\n' > release/lumen-web-v0.2.0-beta.1.tgz
printf 'a mac bundle\n' > release/Lumen_0.2.0-beta.1_aarch64.app.tar.gz
printf 'sbom\n' > release/sbom.cdx.json
( cd release && sha256sum lumen-web-v0.2.0-beta.1.tgz Lumen_0.2.0-beta.1_aarch64.app.tar.gz sbom.cdx.json > SHA256SUMS )
EOF
( cd "$R" && "${G[@]}" add build.sh && "${G[@]}" commit -qm build )
COMMIT="$(git -C "$R" rev-parse HEAD)"
( cd "$R" && node scripts/supply-chain/attest.mjs --out release --key "$T/keys/build.pem" --host oracle-a1 -- bash build.sh > "$T/attest.log" 2>&1 )
expect "attest: provenance with 4 subjects, the commit, a clean tree" 'grep -q "4 subjects, commit ${COMMIT:0:12}, builder oracle-a1" "$T/attest.log" && ! grep -q DIRTY "$T/attest.log"'
expect "attest: a DSSE envelope with an in-toto Statement v1 and a SLSA v1 predicate" 'node -e "const e=JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\"));const s=JSON.parse(Buffer.from(e.payload,\"base64\"));process.exit(e.payloadType===\"application/vnd.in-toto+json\"&&s._type===\"https://in-toto.io/Statement/v1\"&&s.predicateType===\"https://slsa.dev/provenance/v1\"&&s.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit===process.argv[2]?0:1)" "$R/release/provenance.intoto.jsonl" "$COMMIT"'
code=0; ( cd "$R" && node scripts/supply-chain/attest.mjs --out release2 --key "$T/keys/build.pem" -- bash -c "exit 3" > /dev/null 2>&1 ) || code=$?
expect "attest: a failed build gets no provenance and keeps its exit code" '[ $code = 3 ] && [ ! -f "$R/release2/provenance.intoto.jsonl" ]'

echo "3. keyless signing on the Mac (Sigstore stand-in) and the check users run"
mkdir -p "$T/bin"
node --input-type=module -e "
import { localSigstore } from '$R/scripts/supply-chain/sigstore-local.mjs';
import { writeFileSync } from 'node:fs';
const s = localSigstore();
writeFileSync('$T/trusted_root.json', JSON.stringify(s.trustedRoot, null, 2));
writeFileSync('$T/sigstore-keys.json', JSON.stringify(s.exportKeys()));"
cat > "$T/bin/cosign" <<EOF
#!/usr/bin/env bash
echo "cosign \$*" >> "$T/cosign.log"
case "\$1" in
  version) echo "GitVersion:    v3.0.5" ;;
  sign-blob) b=""; f="\${@: -1}"; while [ \$# -gt 0 ]; do [ "\$1" = --bundle ] && b="\$2"; shift; done
    node --input-type=module -e "
      import { localSigstore } from '$R/scripts/supply-chain/sigstore-local.mjs';
      import { readFileSync, writeFileSync } from 'node:fs';
      const s = localSigstore({ keys: JSON.parse(readFileSync('$T/sigstore-keys.json', 'utf8')) });
      writeFileSync(process.argv[1], JSON.stringify(s.signBlob(readFileSync(process.argv[2]), { email: process.env.FAKE_EMAIL || 'tal@example.com', issuer: 'https://github.com/login/oauth' })));" "\$b" "\$f" ;;
  verify-blob) exit "\${FAKE_COSIGN_VERIFY:-0}" ;;
esac
EOF
chmod +x "$T/bin/cosign"
code=0; ( cd "$R" && PATH="$T/bin:$PATH" LUMEN_SIGSTORE_TRUSTED_ROOT="$T/trusted_root.json" LUMEN_SIGSTORE_WITH=sigstore-js bash scripts/supply-chain/sign.sh release > "$T/sign.log" 2>&1 ) || code=$?
expect "sign.sh: a bundle per file and for the provenance, then the whole folder verifies" '[ $code = 0 ] && [ "$(ls "$R"/release/*.sigstore.json | wc -l)" = 5 ] && grep -q "✓ all 5 file(s)" "$T/sign.log"'
expect "sign.sh: cosign sign-blob --yes --bundle <file>.sigstore.json, once per file" '[ "$(grep -c "^cosign sign-blob --yes --bundle" "$T/cosign.log")" = 5 ]'
V=(node "$R/scripts/supply-chain/verify.mjs" --trusted-root "$T/trusted_root.json" --with sigstore-js)
vcode() { local c=0; ( cd "$R" && "$@" > "$T/v.log" 2>&1 ) || c=$?; echo $c; }
expect "verify: the release folder passes, with no network (trust root from a file)" '[ "$(vcode "${V[@]}" release)" = 0 ]'
expect "verify: --commit with the release's commit passes" '[ "$(vcode "${V[@]}" --commit "$COMMIT" release/SHA256SUMS)" = 0 ]'
cp "$R/release/sbom.cdx.json" "$T/sbom.bak"; printf 'sbom!\n' > "$R/release/sbom.cdx.json"
expect "verify: one changed byte fails, both checks name it (exit ≠ 0)" '[ "$(vcode "${V[@]}" release/sbom.cdx.json)" = 1 ] && grep -q "differs from the provenance" "$T/v.log" && grep -q "SIGNATURE_ERROR" "$T/v.log"'
cp "$T/sbom.bak" "$R/release/sbom.cdx.json"
cp "$R/release/SHA256SUMS.sigstore.json" "$R/release/sbom.cdx.json.sigstore.json"
expect "verify: another file's valid bundle is refused" '[ "$(vcode "${V[@]}" release/sbom.cdx.json)" = 1 ]'
( cd "$R" && PATH="$T/bin:$PATH" FAKE_EMAIL=mallory@example.com cosign sign-blob --yes --bundle release/sbom.cdx.json.sigstore.json release/sbom.cdx.json )
expect "verify: a valid signature by another identity is refused" '[ "$(vcode "${V[@]}" release/sbom.cdx.json)" = 1 ] && grep -q "expected tal@example.com, got mallory@example.com" "$T/v.log"'
( cd "$R" && PATH="$T/bin:$PATH" cosign sign-blob --yes --bundle release/sbom.cdx.json.sigstore.json release/sbom.cdx.json )
node --input-type=module -e "
import { localSigstore } from '$R/scripts/supply-chain/sigstore-local.mjs';
import { writeFileSync } from 'node:fs';
writeFileSync('$T/other_root.json', JSON.stringify(localSigstore().trustedRoot));"
expect "verify: bundles from a different Sigstore (another trust root) are refused" '[ "$(vcode node "$R/scripts/supply-chain/verify.mjs" --trusted-root "$T/other_root.json" --with sigstore-js release/SHA256SUMS)" = 1 ]'
expect "verify: provenance checked against a policy signed by another key is refused" '[ "$(vcode "${V[@]}" --policy-key "$T/keys/other.pub" release/SHA256SUMS)" = 1 ] && grep -q "policy:" "$T/v.log"'
( cd "$R" && node scripts/supply-chain/attest.mjs --out release --no-run --key "$T/keys/other.pem" --host oracle-a1 > /dev/null 2>&1 )
( cd "$R" && PATH="$T/bin:$PATH" cosign sign-blob --yes --bundle release/provenance.intoto.jsonl.sigstore.json release/provenance.intoto.jsonl )
expect "verify: provenance signed by a key the policy does not trust is refused" '[ "$(vcode "${V[@]}" release/SHA256SUMS)" = 1 ] && grep -q "no signature by a trusted key" "$T/v.log"'
echo dirty >> "$R/build.sh"
( cd "$R" && node scripts/supply-chain/attest.mjs --out release --no-run --key "$T/keys/build.pem" --host oracle-a1 > /dev/null 2>&1 )
( cd "$R" && PATH="$T/bin:$PATH" cosign sign-blob --yes --bundle release/provenance.intoto.jsonl.sigstore.json release/provenance.intoto.jsonl )
expect "verify: a build from a tree with uncommitted changes is refused" '[ "$(vcode "${V[@]}" release/SHA256SUMS)" = 1 ] && grep -q "uncommitted changes" "$T/v.log"'
( cd "$R" && git checkout -q build.sh && node scripts/supply-chain/attest.mjs --out release --no-run --key "$T/keys/build.pem" --host laptop > /dev/null 2>&1 )
( cd "$R" && PATH="$T/bin:$PATH" cosign sign-blob --yes --bundle release/provenance.intoto.jsonl.sigstore.json release/provenance.intoto.jsonl )
expect "verify: a build on a host the policy does not name is refused" '[ "$(vcode "${V[@]}" release/SHA256SUMS)" = 1 ] && grep -q "not one the policy names" "$T/v.log"'
echo '{"identity":"${LUMEN_SIGSTORE_IDENTITY}","issuer":"https://github.com/login/oauth"}' > "$T/placeholder.json"
expect "verify: the unfilled identity placeholder is refused by name" '[ "$(vcode "${V[@]}" --identity "$T/placeholder.json" release)" = 1 ] && grep -q "LUMEN_SIGSTORE_IDENTITY" "$T/v.log"'
: > "$T/cosign.log"; ( cd "$R" && PATH="$T/bin:$PATH" node scripts/supply-chain/verify.mjs --trusted-root "$T/trusted_root.json" release/SHA256SUMS > /dev/null 2>&1 ) || true
expect "with cosign ≥ 3.0.4 installed, verify.mjs calls verify-blob with the pinned identity, issuer and --offline" 'grep -q -- "verify-blob .*SHA256SUMS --bundle .*SHA256SUMS.sigstore.json --certificate-identity tal@example.com --certificate-oidc-issuer https://github.com/login/oauth --trusted-root .* --offline" "$T/cosign.log"'
bash "$R/scripts/supply-chain/install-tools.sh" --dry-run > "$T/tools.log" 2>&1 || true
expect "install-tools.sh --dry-run: pinned Witness and cosign, each checked against its release checksums" 'grep -q "witness_0.11.0_checksums.txt" "$T/tools.log" && grep -q "sha256 cosign-linux-.* against cosign.sums" "$T/tools.log"'

echo
echo "supply-chain selftest: $pass passed, $fail failed"
[ "$fail" = 0 ]
