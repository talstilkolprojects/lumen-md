#!/usr/bin/env bash
# Install the pinned supply-chain tools on the build host (plan W7.22):
# Witness (in-toto, CNCF) and cosign, from their GitHub releases, each
# checked against the release's own checksum file before it is installed.
#
#   sudo bash scripts/supply-chain/install-tools.sh            Ubuntu (x86_64 or arm64): /usr/local/bin
#   bash scripts/supply-chain/install-tools.sh --dry-run       print what it would fetch
#   On the Mac: brew install cosign (only signing happens there).
#
# The versions are pinned here; raising one is a reviewed change. cosign must
# stay ≥ 3.0.4 (GHSA-whqx-f9j3-ch6m). The script prints each binary's sha256:
# record it in the PR that installs the host.
set -euo pipefail
WITNESS_VERSION=0.11.0
COSIGN_VERSION=3.0.5
DRY=0; [ "${1:-}" = --dry-run ] && DRY=1
case "$(uname -m)" in x86_64|amd64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo "install-tools: unsupported $(uname -m)" >&2; exit 2 ;; esac
[ "$(uname -s)" = Linux ] || { echo "install-tools: Linux only; on the Mac: brew install cosign" >&2; exit 2; }
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fetch() { if [ "$DRY" = 1 ]; then echo "  + fetch $1"; else curl -fsSL --retry 3 -o "$T/$2" "$1"; fi; }
check() { # check <file> <checksums file>
  [ "$DRY" = 1 ] && { echo "  + sha256 $1 against $2"; return 0; }
  want="$(awk -v f="$1" '$2 == f || $2 == "*"f {print $1}' "$T/$2")"
  [ -n "$want" ] || { echo "install-tools: $1 is not in $2" >&2; exit 1; }
  got="$(sha256sum "$T/$1" | cut -d' ' -f1)"
  [ "$want" = "$got" ] || { echo "install-tools: $1: sha256 $got, the release says $want" >&2; exit 1; }
  echo "  ✓ $1 sha256 $got"
}
W="witness_${WITNESS_VERSION}_linux_${ARCH}.tar.gz"
fetch "https://github.com/in-toto/witness/releases/download/v${WITNESS_VERSION}/$W" "$W"
fetch "https://github.com/in-toto/witness/releases/download/v${WITNESS_VERSION}/witness_${WITNESS_VERSION}_checksums.txt" witness.sums
check "$W" witness.sums
C="cosign-linux-${ARCH}"
fetch "https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/$C" "$C"
fetch "https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign_checksums.txt" cosign.sums
check "$C" cosign.sums
if [ "$DRY" = 1 ]; then echo "dry run: nothing installed"; exit 0; fi
tar -xzf "$T/$W" -C "$T" witness
install -m 0755 "$T/witness" /usr/local/bin/witness
install -m 0755 "$T/$C" /usr/local/bin/cosign
witness version; cosign version | grep -i gitversion
