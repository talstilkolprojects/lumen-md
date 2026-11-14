#!/usr/bin/env bash
# Keyless Sigstore signing of a release folder, on Tal's Mac (plan W7.22).
#
#   bash scripts/supply-chain/sign.sh release/
#
# For every release file (and the provenance itself): `cosign sign-blob --yes
# --bundle <file>.sigstore.json <file>`. Each one opens the browser for the
# Sigstore login (GitHub, as security/sigstore-identity.json says); Fulcio
# issues a 10-minute certificate for that identity and the signature goes into
# Rekor, the public log. No private key is kept anywhere. Then verify.mjs
# checks the whole folder, the way users and the release gate will.
set -euo pipefail
dir="${1:?usage: sign.sh <release folder>}"
cd "$(dirname "$0")/../.."
[ -f "$dir/provenance.intoto.jsonl" ] || { echo "sign: $dir has no provenance.intoto.jsonl: build it with scripts/supply-chain/attest.mjs on the build host first" >&2; exit 2; }
command -v cosign >/dev/null || { echo "sign: cosign is not installed (brew install cosign)" >&2; exit 2; }
ver="$(cosign version 2>&1 | node --input-type=module -e "import {cosignVersion} from './scripts/supply-chain/lib.mjs'; let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>console.log(cosignVersion(s) ?? ''))")"
node --input-type=module -e "import {versionAtLeast,COSIGN_MIN} from './scripts/supply-chain/lib.mjs'; process.exit(versionAtLeast('${ver:-0.0.0}', COSIGN_MIN) ? 0 : 1)" \
  || { echo "sign: cosign ${ver:-?} is older than the minimum in scripts/supply-chain/lib.mjs (GHSA-whqx-f9j3-ch6m): brew upgrade cosign" >&2; exit 2; }
node --input-type=module -e "
import { identityProblems } from './scripts/supply-chain/lib.mjs';
import { readFileSync } from 'node:fs';
const p = identityProblems(JSON.parse(readFileSync('security/sigstore-identity.json', 'utf8')));
for (const x of p) console.error('sign: ' + x);
process.exit(p.length ? 1 : 0);"
# (a while-read loop, not mapfile: macOS ships bash 3.2)
files=()
while IFS= read -r line; do [ -n "$line" ] && files+=("$line"); done < <(node --input-type=module -e "
import { NOT_SUBJECT } from './scripts/supply-chain/lib.mjs';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
const out = [];
const walk = (d) => { for (const n of readdirSync(d).sort()) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else { const r = relative('$dir', f); if ((!NOT_SUBJECT.test(r) && r !== 'build.log') || r === 'provenance.intoto.jsonl') out.push(f); } } };
walk('$dir'); console.log(out.join('\n'));")
echo "sign: ${#files[@]} files with cosign $ver (one browser login each)"
for f in "${files[@]}"; do
  echo "  $f"
  cosign sign-blob --yes --bundle "$f.sigstore.json" "$f" > /dev/null
done
node scripts/supply-chain/verify.mjs "$dir"
