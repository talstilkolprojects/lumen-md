#!/usr/bin/env bash
# Install a Buildkite agent for lumen-md's pipeline (plan W7.21) on the
# factory's second host (Ubuntu 24.04, after scripts/factory/bootstrap.sh,
# #509) or on Tal's Mac.
#
#   printf '%s\n%s\n' "$AGENT_TOKEN" "$API_TOKEN" | sudo bash scripts/buildkite/agent-bootstrap.sh --secrets-stdin --org <slug>
#   bash scripts/buildkite/agent-bootstrap.sh --dry-run          print every action, change nothing
#   printf '%s\n' "$AGENT_TOKEN" | bash scripts/buildkite/agent-bootstrap.sh --secrets-stdin   (the Mac: agent only)
#
# Secrets come on stdin, never in argv (argv is visible in `ps`): line 1 the
# agent token, line 2 (Ubuntu only, optional) an API access token with
# read_builds + write_builds for the trigger (scripts/buildkite/trigger.mjs).
#
# Ubuntu: Buildkite's apt repository (signed key from keys.openpgp.org, as
# buildkite.com/docs/agent/v3/ubuntu gives it), the agent as the factory's
# `lumen` user (in the docker group), tags queue=linux, a systemd timer that
# runs the trigger every 5 minutes.
# Mac: Homebrew's buildkite/buildkite tap, tags queue=mac, a LaunchAgent in
# the logged-in user's session (WebKit needs a GUI session for some tests).
#
# The agent refuses any repository but lumen-md (allowed-repositories), runs
# no plugins and no hooks from the checkout (no-plugins, no-local-hooks):
# only scripts/buildkite/run.sh, which runs the job in the Playwright image.
#
# Options: --dry-run, --secrets-stdin, --org <slug>, --pipeline <slug> (default lumen-md),
#          --spawn N (default 2 on Ubuntu, 1 on the Mac), --no-trigger
# Environment: LUMEN_BUILDKITE_ROOT  prefix for every path written (the self-test)
set -euo pipefail
DRY=0; SECRETS=0; ORG=""; PIPE=lumen-md; SPAWN=""; TRIGGER=1
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --secrets-stdin) SECRETS=1 ;;
    --org) ORG="${2:?--org needs a slug}"; shift ;;
    --pipeline) PIPE="${2:?--pipeline needs a slug}"; shift ;;
    --spawn) SPAWN="${2:?--spawn needs a number}"; shift ;;
    --no-trigger) TRIGGER=0 ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "agent-bootstrap: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
[ -z "$SPAWN" ] || [[ "$SPAWN" =~ ^[1-9][0-9]?$ ]] || { echo "agent-bootstrap: --spawn must be 1-99" >&2; exit 2; }
[[ "$ORG" =~ ^[a-z0-9-]*$ ]] || { echo "agent-bootstrap: --org must be a Buildkite slug (a-z, 0-9, -)" >&2; exit 2; }

OS=$(uname -s)
ROOT="${LUMEN_BUILDKITE_ROOT:-/}"; ROOT="${ROOT%/}"
ALLOWED='^https://github\.com/talstilkol/lumen-md(\.git)?$'
if [ "$OS" = Darwin ]; then
  QUEUE=mac; EXEC=native; SPAWN="${SPAWN:-1}"; TRIGGER=0
  FHOME="${ROOT}${HOME}/lumen-factory"; FENV="$FHOME/etc/env"
  BREW="$(command -v brew >/dev/null 2>&1 && brew --prefix || echo /opt/homebrew)"
  CFG="${ROOT}$BREW/etc/buildkite-agent/buildkite-agent.cfg"; HOOKS="$FHOME/etc/buildkite-hooks"; BUILDS="$FHOME/buildkite/builds"
else
  QUEUE=linux; EXEC=docker; SPAWN="${SPAWN:-2}"
  FHOME="${ROOT}/srv/lumen-factory"; FENV="${ROOT}/etc/lumen-factory/env"
  CFG="${ROOT}/etc/buildkite-agent/buildkite-agent.cfg"; HOOKS="${ROOT}/etc/buildkite-agent/hooks"; BUILDS="$FHOME/buildkite/builds"
fi
[ "$DRY" = 1 ] && { DRYDIR="$(mktemp -d)"; }

say() { printf '\033[1m▶ %s\033[0m\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then printf '  + %s\n' "$*"; else "$@"; fi; }
write() { # write <file> <mode>: stdin → file (a temp dir in --dry-run)
  local f="$1" mode="$2"
  [ "$DRY" = 1 ] && f="$DRYDIR/$(basename "$f")"
  mkdir -p "$(dirname "$f")"; cat > "$f"; chmod "$mode" "$f"
  [ "$DRY" = 1 ] && printf '  + write %s (%s), %s lines\n' "$1" "$mode" "$(wc -l < "$f")"
  return 0
}

if [ "$OS" != Darwin ] && [ "$DRY" = 0 ] && [ "$(id -u)" != 0 ] && [ -z "${LUMEN_BUILDKITE_ROOT:-}" ]; then echo "agent-bootstrap: run it with sudo on Ubuntu" >&2; exit 2; fi
if [ "$DRY" = 0 ] && [ ! -f "$FENV" ]; then echo "agent-bootstrap: $FENV is missing: run scripts/factory/bootstrap.sh first (the agent uses the factory's user, image and signing key)" >&2; exit 2; fi

# ── secrets ────────────────────────────────────────────────────────────────
AGENT_TOKEN=""; API_TOKEN=""
if [ "$SECRETS" = 1 ]; then
  IFS= read -r AGENT_TOKEN || true
  IFS= read -r API_TOKEN || true
  [[ "$AGENT_TOKEN" =~ ^[A-Za-z0-9_-]{20,}$ ]] || { echo "agent-bootstrap: line 1 of stdin is not an agent token" >&2; exit 2; }
  [ -z "$API_TOKEN" ] || [[ "$API_TOKEN" =~ ^[A-Za-z0-9_-]{20,}$ ]] || { echo "agent-bootstrap: line 2 of stdin is not an API token" >&2; exit 2; }
elif [ "$DRY" = 0 ]; then
  echo "agent-bootstrap: pass the agent token on stdin with --secrets-stdin (docs: self-hosting/buildkite)" >&2; exit 2
fi
if [ "$TRIGGER" = 1 ] && [ "$DRY" = 0 ] && { [ -z "$API_TOKEN" ] || [ -z "$ORG" ]; }; then
  echo "agent-bootstrap: the trigger needs --org and an API token on line 2 (or pass --no-trigger)" >&2; exit 2
fi

# ── 1. the agent ───────────────────────────────────────────────────────────
if [ "$OS" = Darwin ]; then
  say "1/5 buildkite-agent from Homebrew (buildkite/buildkite tap)"
  command -v buildkite-agent >/dev/null 2>&1 || run brew install buildkite/buildkite/buildkite-agent
else
  say "1/5 buildkite-agent from Buildkite's apt repository"
  KEYRING="${ROOT}/usr/share/keyrings/buildkite-agent-archive-keyring.gpg"
  run bash -c "curl -fsSL https://keys.openpgp.org/vks/v1/by-fingerprint/32A37959C2FA5C3C99EFBC32A79206696452D198 | gpg --dearmor --yes -o '$KEYRING'"
  echo "deb [signed-by=/usr/share/keyrings/buildkite-agent-archive-keyring.gpg] https://apt.buildkite.com/buildkite-agent stable main" | write "${ROOT}/etc/apt/sources.list.d/buildkite-agent.list" 644
  run apt-get update -q
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y -q buildkite-agent
fi

# ── 2. configuration ───────────────────────────────────────────────────────
say "2/5 $CFG: queue=$QUEUE, spawn=$SPAWN, lumen-md only, no plugins, no checkout hooks"
{
  echo "# lumen-md (plan W7.21), written by scripts/buildkite/agent-bootstrap.sh"
  echo "token=\"${AGENT_TOKEN:-xxx}\""
  echo "name=\"lumen-${QUEUE}-%spawn\""
  echo "tags=\"queue=${QUEUE},exec=${EXEC},arch=$(uname -m)\""
  echo "spawn=${SPAWN}"
  echo "build-path=\"${BUILDS}\""
  echo "hooks-path=\"${HOOKS}\""
  echo "allowed-repositories=\"${ALLOWED}\""
  echo "no-plugins=true"
  echo "no-local-hooks=true"
  echo "git-clean-flags=\"-ffxdq\""
} | write "$CFG" 600
write "$HOOKS/environment" 755 <<EOF
#!/usr/bin/env bash
# Every job: the factory's settings (user, signing key, receipts clone, token file), then the CI's own.
set -a; . "$FENV"; [ -f "$(dirname "$FENV")/buildkite.env" ] && . "$(dirname "$FENV")/buildkite.env"; set +a
export LUMEN_CI_EXEC=$EXEC LUMEN_CI_CACHE="$FHOME/cache/ci"
mkdir -p "\$LUMEN_CI_CACHE"
EOF
run mkdir -p "$BUILDS" "$FHOME/cache/ci"

# ── 3. the service ─────────────────────────────────────────────────────────
if [ "$OS" = Darwin ]; then
  say "3/5 LaunchAgent dev.lumen-md.buildkite-agent (the logged-in user's session)"
  PLIST="${ROOT}${HOME}/Library/LaunchAgents/dev.lumen-md.buildkite-agent.plist"
  write "$PLIST" 644 <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.lumen-md.buildkite-agent</string>
  <key>ProgramArguments</key><array><string>$BREW/bin/buildkite-agent</string><string>start</string><string>--config</string><string>$CFG</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$BREW/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$FHOME/logs/buildkite-agent.log</string>
  <key>StandardErrorPath</key><string>$FHOME/logs/buildkite-agent.log</string>
</dict></plist>
EOF
  run mkdir -p "$FHOME/logs"
  run launchctl bootout "gui/$(id -u)/dev.lumen-md.buildkite-agent" 2>/dev/null || true
  run launchctl bootstrap "gui/$(id -u)" "$PLIST"
else
  say "3/5 systemd: the agent runs as lumen (docker group), not as buildkite-agent"
  write "${ROOT}/etc/systemd/system/buildkite-agent.service.d/lumen.conf" 644 <<EOF
# lumen-md (plan W7.21): the factory's user owns the image cache, the signing key and the receipts clone.
[Service]
User=lumen
Group=lumen
SupplementaryGroups=docker
Environment=HOME=$FHOME
EOF
  run chown -R lumen:lumen "$BUILDS" "$FHOME/cache/ci" "$(dirname "$CFG")"
  run systemctl daemon-reload
  run systemctl enable --now buildkite-agent
fi

# ── 4. the trigger (Ubuntu) ────────────────────────────────────────────────
if [ "$TRIGGER" = 1 ]; then
  say "4/5 the trigger: every 5 minutes, new PR heads → Buildkite builds (webhook builds would be skipped: [skip ci])"
  ETC="$(dirname "$FENV")"
  [ "$DRY" = 1 ] || [ -f "$FHOME/tool/scripts/buildkite/trigger.mjs" ] || echo "agent-bootstrap: warning: $FHOME/tool has no scripts/buildkite/trigger.mjs; check out the branch that has it (scripts/factory/bootstrap.sh --branch …, or git -C $FHOME/tool checkout)" >&2
  if [ -n "$API_TOKEN" ]; then printf '%s\n' "$API_TOKEN" | write "$ETC/buildkite-api-token" 600; fi
  write "$ETC/buildkite.env" 644 <<EOF
LUMEN_BUILDKITE_ORG=$ORG
LUMEN_BUILDKITE_PIPELINE=$PIPE
LUMEN_BUILDKITE_TOKEN_FILE=$ETC/buildkite-api-token
EOF
  write "${ROOT}/etc/systemd/system/lumen-buildkite-trigger.service" 644 <<EOF
[Unit]
Description=lumen-md: Buildkite builds for new PR heads (plan W7.21)
Wants=network-online.target
After=network-online.target
[Service]
Type=oneshot
User=lumen
EnvironmentFile=$FENV
EnvironmentFile=$ETC/buildkite.env
ExecStart=/usr/bin/env node $FHOME/tool/scripts/buildkite/trigger.mjs
TimeoutStartSec=120
EOF
  write "${ROOT}/etc/systemd/system/lumen-buildkite-trigger.timer" 644 <<EOF
[Unit]
Description=lumen-md: poll for new PR heads every 5 minutes (plan W7.21)
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
EOF
  run chown lumen:lumen "$ETC/buildkite-api-token" 2>/dev/null || true
  run systemctl daemon-reload
  run systemctl enable --now lumen-buildkite-trigger.timer
else
  say "4/5 the trigger: not on this machine"
fi

# ── 5. self-check ──────────────────────────────────────────────────────────
say "5/5 self-check"
run buildkite-agent --version
if [ "$DRY" = 1 ]; then echo "dry run: nothing was changed (files written to $DRYDIR)"; else echo "✓ agent installed: queue=$QUEUE. It appears under Agents in Buildkite within a minute."; fi
