#!/usr/bin/env bash
# The verification factory (plan W6.5): turn a fresh Ubuntu 24.04 VM (an Oracle
# Cloud Always Free Ampere A1, or any x86/arm64 Ubuntu) or a Mac into the host
# that tests every verify/* head each night in chromium, firefox and webkit
# and signs a receipt for each (scripts/factory/run.mjs).
#
#   Ubuntu:  sudo bash bootstrap.sh --secrets-stdin < secrets
#   Mac:     bash bootstrap.sh --secrets-stdin < secrets        (no sudo; steps run natively)
#   Either:  bash bootstrap.sh --dry-run                        (print every action, change nothing)
#
# secrets (stdin, never a command-line argument): line 1 the fine-grained
# GitHub token (repository talstilkol/lumen-md, permission "Commit statuses:
# read and write", nothing else); then the private half of the receipts
# repository's deploy key (OpenSSH format). docs: self-hosting/verification-factory.
#
# Options:
#   --branch <b>       the branch the factory's own code comes from (default chore/verify-factory; main once merged)
#   --at HH:MM         nightly start, Israel time (default 01:17)
#   --run-now          start the first night right after installing
#   --dry-run          print what would happen; write nothing outside a temp dir
# Environment, for the self-test (scripts/factory/selftest.sh):
#   LUMEN_FACTORY_ROOT    prefix for every path written (default /)
#   LUMEN_FACTORY_REMOTE  the lumen-md repository to clone (default GitHub)
#   LUMEN_RECEIPTS_REMOTE the receipts repository (default git@github-receipts:talstilkol/lumen-md-receipts.git)
set -euo pipefail

BRANCH=chore/verify-factory
AT=01:17
DRY=0
RUN_NOW=0
SECRETS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH="$2"; shift 2 ;;
    --at) AT="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --run-now) RUN_NOW=1; shift ;;
    --secrets-stdin) SECRETS=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "bootstrap: unknown option $1" >&2; exit 2 ;;
  esac
done
[[ "$AT" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || { echo "bootstrap: --at must be HH:MM" >&2; exit 2; }

OS=$(uname -s)
ROOT="${LUMEN_FACTORY_ROOT:-/}"; ROOT="${ROOT%/}"
REMOTE="${LUMEN_FACTORY_REMOTE:-https://github.com/talstilkol/lumen-md.git}"
RECEIPTS_REMOTE="${LUMEN_RECEIPTS_REMOTE:-git@github-receipts:talstilkol/lumen-md-receipts.git}"
if [ "$OS" = Darwin ]; then
  USER_NAME="$(id -un)"; FHOME="${ROOT}${HOME}/lumen-factory"; ETC="$FHOME/etc"; EXEC=native; HOST_LABEL=mac
else
  USER_NAME=lumen; FHOME="${ROOT}/srv/lumen-factory"; ETC="${ROOT}/etc/lumen-factory"; EXEC=docker; HOST_LABEL="${LUMEN_FACTORY_HOST:-$( [ "$(uname -m)" = aarch64 ] && echo oracle-a1 || echo linux)}"
fi
[ "$DRY" = 1 ] && { ROOT_DRY="$(mktemp -d)"; ETC="$ROOT_DRY/etc"; }

say() { printf '\033[1m▶ %s\033[0m\n' "$*"; }
# Every command that changes the machine goes through run: printed in --dry-run, executed otherwise.
run() { if [ "$DRY" = 1 ]; then printf '  + %s\n' "$*"; else "$@"; fi; }
as_user() { if [ "$OS" = Darwin ] || [ "$(id -un)" = "$USER_NAME" ]; then run "$@"; else run sudo -u "$USER_NAME" -H "$@"; fi; }
write() { # write <file> <mode>: stdin → file (a temp dir in --dry-run)
  local f="$1" mode="$2"
  if [ "$DRY" = 1 ]; then f="$ROOT_DRY/$(basename "$f")"; fi
  mkdir -p "$(dirname "$f")"; cat > "$f"; chmod "$mode" "$f"
  [ "$DRY" = 1 ] && printf '  + write %s (%s), %s lines\n' "$1" "$mode" "$(wc -l < "$f")"
  return 0
}

if [ "$OS" != Darwin ] && [ "$DRY" = 0 ] && [ "$(id -u)" != 0 ]; then echo "bootstrap: run it with sudo on Ubuntu" >&2; exit 2; fi

# ── secrets ────────────────────────────────────────────────────────────────
TOKEN=""; DEPLOY_KEY=""
if [ "$SECRETS" = 1 ]; then
  IFS= read -r TOKEN || true
  DEPLOY_KEY="$(cat)"
  [[ "$TOKEN" =~ ^github_pat_[A-Za-z0-9_]{20,}$ ]] || { echo "bootstrap: line 1 of the secrets is not a fine-grained token (github_pat_…)" >&2; exit 2; }
  grep -q "BEGIN OPENSSH PRIVATE KEY" <<<"$DEPLOY_KEY" || { echo "bootstrap: no OpenSSH private key after the token" >&2; exit 2; }
elif [ "$DRY" = 0 ]; then
  echo "bootstrap: pass the token and the deploy key on stdin with --secrets-stdin (docs: self-hosting/verification-factory)" >&2; exit 2
fi

# ── 1. packages ────────────────────────────────────────────────────────────
if [ "$OS" = Darwin ]; then
  say "1/7 tools (Mac): node ≥ 22, git, gh"
  for t in node git gh; do command -v "$t" >/dev/null || { echo "bootstrap: $t is missing: brew install $t" >&2; [ "$DRY" = 1 ] || exit 2; }; done
else
  say "1/7 packages: Docker (Ubuntu's docker.io), git, gh, Node 22"
  run apt-get update -q
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y -q docker.io git gh curl ca-certificates openssh-client
  if ! node -v 2>/dev/null | grep -q '^v22\.'; then
    run bash -c 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y -q nodejs'
  fi
  run systemctl enable --now docker
  # 12 GB on the free Ampere shape: swap keeps a parallel webkit + vitest peak from the OOM killer.
  if [ -z "$ROOT" ] && [ "$(awk '/MemTotal/{print int($2/1048576)}' /proc/meminfo 2>/dev/null || echo 99)" -lt 16 ] && [ -z "$(swapon --show=NAME --noheadings 2>/dev/null)" ]; then
    run bash -c "fallocate -l 4G '${ROOT}/swapfile' && chmod 600 '${ROOT}/swapfile' && mkswap '${ROOT}/swapfile' && swapon '${ROOT}/swapfile' && echo '/swapfile none swap sw 0 0' >> '${ROOT}/etc/fstab'"
  fi
  say "2/7 user $USER_NAME (in the docker group), home $FHOME"
  id "$USER_NAME" >/dev/null 2>&1 || run useradd --system --create-home --home-dir "$FHOME" --shell /bin/bash "$USER_NAME"
  run usermod -aG docker "$USER_NAME"
fi
run mkdir -p "$FHOME" "$ETC"

# ── 3. secrets on disk ─────────────────────────────────────────────────────
say "3/7 the token and the deploy key (mode 0600, readable by $USER_NAME only)"
if [ -n "$TOKEN" ]; then printf '%s\n' "$TOKEN" | write "$ETC/token" 600; fi
SSH_DIR="$FHOME/.ssh"
if [ -n "$DEPLOY_KEY" ]; then printf '%s\n' "$DEPLOY_KEY" | write "$SSH_DIR/receipts_deploy" 600; fi
write "$SSH_DIR/config" 600 <<EOF
# The receipts repository's deploy key (write access to that repository only)
Host github-receipts
  HostName github.com
  User git
  IdentityFile $SSH_DIR/receipts_deploy
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
EOF
[ "$OS" = Darwin ] || run chown -R "$USER_NAME:$USER_NAME" "$FHOME" "$ETC"

# ── 4. code, receipts and the signing key ──────────────────────────────────
say "4/7 the factory's code ($BRANCH), the receipts repository, the signing key"
[ -d "$FHOME/tool/.git" ] || as_user git clone -q --branch "$BRANCH" "$REMOTE" "$FHOME/tool"
[ -d "$FHOME/receipts/.git" ] || as_user env GIT_SSH_COMMAND="ssh -F $SSH_DIR/config" git clone -q "$RECEIPTS_REMOTE" "$FHOME/receipts"
KEY="$FHOME/.config/lumen-md/nightly-ed25519.pem"
as_user env LUMEN_NIGHTLY_KEY="$KEY" node --input-type=module -e "
  const { loadOrCreateKey, sha256 } = await import('$FHOME/tool/scripts/nightly/receipt.mjs');
  const { publicKeyPem } = loadOrCreateKey(process.env.LUMEN_NIGHTLY_KEY);
  console.log('signing key ' + sha256(publicKeyPem).slice(0, 16) + ' (public half below; the first night commits it as keys/$HOST_LABEL.pem in the receipts repository)');
  console.log(publicKeyPem.trim());"

# ── 5. configuration ───────────────────────────────────────────────────────
say "5/7 configuration: $ETC/env"
write "$ETC/env" 644 <<EOF
LUMEN_FACTORY_HOME=$FHOME
LUMEN_FACTORY_EXEC=$EXEC
LUMEN_FACTORY_HOST=$HOST_LABEL
LUMEN_FACTORY_TOKEN_FILE=$ETC/token
LUMEN_FACTORY_REMOTE=$REMOTE
LUMEN_NIGHTLY_KEY=$KEY
GIT_SSH_COMMAND="ssh -F $SSH_DIR/config"
EOF

# ── 6. schedule ────────────────────────────────────────────────────────────
H=${AT%:*}; M=${AT#*:}
if [ "$OS" = Darwin ]; then
  say "6/7 schedule: LaunchAgent dev.lumen-md.factory at $AT (local time; a missed night runs on wake)"
  PLIST="${ROOT}${HOME}/Library/LaunchAgents/dev.lumen-md.factory.plist"
  write "$PLIST" 644 <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.lumen-md.factory</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>set -a; . '$ETC/env'; set +a; git -C '$FHOME/tool' pull -q --ff-only; node '$FHOME/tool/scripts/factory/run.mjs' --scheduled</string>
  </array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>$((10#$H))</integer><key>Minute</key><integer>$((10#$M))</integer></dict>
  <key>StandardOutPath</key><string>$FHOME/logs/launchd.log</string>
  <key>StandardErrorPath</key><string>$FHOME/logs/launchd.log</string>
</dict>
</plist>
EOF
  run mkdir -p "$FHOME/logs"
  run launchctl bootout "gui/$(id -u)/dev.lumen-md.factory" 2>/dev/null || true
  run launchctl bootstrap "gui/$(id -u)" "$PLIST"
  [ "$RUN_NOW" = 1 ] && run launchctl kickstart "gui/$(id -u)/dev.lumen-md.factory"
else
  say "6/7 schedule: systemd timer lumen-factory.timer at $AT Asia/Jerusalem (Persistent: a missed night runs at boot)"
  write "${ROOT}/etc/systemd/system/lumen-factory.service" 644 <<EOF
[Unit]
Description=Lumen verification factory: one night of tests over every verify/* head (plan W6.5)
Wants=network-online.target docker.service
After=network-online.target docker.service

[Service]
Type=oneshot
User=$USER_NAME
EnvironmentFile=$ETC/env
WorkingDirectory=$FHOME/tool
ExecStartPre=/usr/bin/git -C $FHOME/tool pull -q --ff-only
ExecStart=/usr/bin/node $FHOME/tool/scripts/factory/run.mjs --scheduled
TimeoutStartSec=10h
Nice=5
EOF
  write "${ROOT}/etc/systemd/system/lumen-factory.timer" 644 <<EOF
[Unit]
Description=Start the Lumen verification factory every night

[Timer]
OnCalendar=*-*-* $AT:00 Asia/Jerusalem
Persistent=true

[Install]
WantedBy=timers.target
EOF
  run systemctl daemon-reload
  run systemctl enable --now lumen-factory.timer
  [ "$RUN_NOW" = 1 ] && run systemctl start --no-block lumen-factory.service
fi

# ── 7. check ───────────────────────────────────────────────────────────────
say "7/7 check: the receipts remote answers, the token can see the repository, the factory plans a night"
as_user env GIT_SSH_COMMAND="ssh -F $SSH_DIR/config" git ls-remote -q "$RECEIPTS_REMOTE" HEAD
if [ -n "$TOKEN" ] || [ "$DRY" = 1 ]; then as_user env GH_TOKEN="${TOKEN:-<token>}" gh api repos/talstilkol/lumen-md --jq '"token ok: " + .full_name'; fi
[ "$OS" = Darwin ] || run docker info --format 'docker {{.ServerVersion}} on {{.Architecture}}'
as_user env LUMEN_FACTORY_HOME="$FHOME" LUMEN_FACTORY_EXEC="$EXEC" LUMEN_FACTORY_HOST="$HOST_LABEL" LUMEN_FACTORY_REMOTE="$REMOTE" LUMEN_NIGHTLY_KEY="$KEY" node "$FHOME/tool/scripts/factory/run.mjs" --dry-run
say "done. Logs: $( [ "$OS" = Darwin ] && echo "$FHOME/logs/launchd.log" || echo 'journalctl -u lumen-factory' ). Receipts: https://github.com/talstilkol/lumen-md-receipts"
[ "$DRY" = 1 ] && echo "(dry run: nothing was changed; the files it would write are in $ROOT_DRY)"
exit 0
