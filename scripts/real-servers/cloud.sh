#!/usr/bin/env bash
# Dropbox and Google Drive against the real services (plan W6.27). Owner-run:
# it needs your accounts. Nothing here is sent anywhere but Dropbox and Google.
#
# 1. Dropbox: https://www.dropbox.com/developers/apps → Create app → Scoped
#    access, App folder → Permissions: files.content.write, files.content.read,
#    files.metadata.read → Submit → Settings → OAuth 2 → Generated access token
#    → Generate. Then: export LUMEN_REAL_DROPBOX_TOKEN='<token>'
# 2. Google Drive: https://developers.google.com/oauthplayground → step 1, type
#    the scope https://www.googleapis.com/auth/drive.file → Authorize APIs →
#    step 2, Exchange authorization code for tokens → copy "Access token".
#    Then: export LUMEN_REAL_GDRIVE_TOKEN='<token>'
# 3. scripts/real-servers/cloud.sh
# Both tokens last about 4 hours (Dropbox) and 1 hour (Drive). The test makes
# its own folders (lumen-real-<run>-…) and deletes what it writes, except the
# folders themselves; delete them by hand afterwards.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -n "${LUMEN_REAL_DROPBOX_TOKEN:-}" ] || [ -n "${LUMEN_REAL_GDRIVE_TOKEN:-}" ] || { echo "Set LUMEN_REAL_DROPBOX_TOKEN and/or LUMEN_REAL_GDRIVE_TOKEN (see the top of this file)." >&2; exit 1; }
node -e '
const c = require("./scripts/real-servers/servers.cloud.json");
c.servers = c.servers.filter((s) => process.env[s.tokenEnv]);
require("node:fs").writeFileSync(process.argv[1], JSON.stringify(c));
' /tmp/lumen-real-cloud.json
LUMEN_REAL_SERVERS=/tmp/lumen-real-cloud.json LUMEN_REAL_SERVERS_OUT=/tmp/lumen-real-cloud-results.json LUMEN_REAL_SERVERS_ROUNDS=3 LUMEN_REAL_SERVERS_PROBES=3 \
  npx vitest run src/__tests__/providersRealServers.test.ts || true
node scripts/real-servers/table.mjs /tmp/lumen-real-cloud-results.json
