#!/usr/bin/env bash
# Real WebDAV and S3 servers on this machine, without Docker (plan W6.27).
# Starts what is installed, writes the servers file the test reads, and runs
#   src/__tests__/providersRealServers.test.ts
# against them. Install first (any that you want):
#   pip install wsgidav cheroot 'moto[server]'
#   nginx with the dav module (brew install nginx / apt install nginx)
#   php (for sabre/dav: composer require sabre/dav in $WORK/sabre)
#   go (for golang.org/x/net/webdav: the server in gowebdav/)
# Usage: scripts/real-servers/local.sh [work dir]   (default: a temp dir)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="${1:-$(mktemp -d)}"
mkdir -p "$WORK/data"
SERVERS="$WORK/servers.json"
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; [ -f "$WORK/nginx.pid" ] && kill "$(cat "$WORK/nginx.pid")" 2>/dev/null || true; }
trap cleanup EXIT
entries=()
wait_for() { for _ in $(seq 1 50); do curl -s -o /dev/null "$1" && return 0; sleep 0.2; done; return 1; }

if python3 -c "import wsgidav, cheroot" 2>/dev/null; then
  mkdir -p "$WORK/data/wsgidav/Lumen"
  wsgidav --host 127.0.0.1 --port 18081 --root "$WORK/data/wsgidav" --auth anonymous --server cheroot -q > "$WORK/wsgidav.log" 2>&1 &
  PIDS+=($!)
  wait_for http://127.0.0.1:18081/ && entries+=('{"name":"WsgiDAV","kind":"webdav","url":"http://127.0.0.1:18081/Lumen/"}')
fi

if python3 -c "import moto.server" 2>/dev/null; then
  python3 -m moto.server -H 127.0.0.1 -p 18082 > "$WORK/moto.log" 2>&1 &
  PIDS+=($!)
  wait_for http://127.0.0.1:18082/ && curl -s -X PUT http://127.0.0.1:18082/lumen > /dev/null &&
    entries+=('{"name":"moto (S3)","kind":"s3","endpoint":"http://127.0.0.1:18082","region":"us-east-1","bucket":"lumen","accessKeyId":"AKIAREALTEST","secretAccessKey":"real/secret+1","pathStyle":true}')
fi

if command -v nginx > /dev/null; then
  mkdir -p "$WORK/data/nginx/Lumen" "$WORK/nginx-tmp"
  cat > "$WORK/nginx.conf" <<EOF
pid $WORK/nginx.pid;
error_log $WORK/nginx-error.log;
events { worker_connections 256; }
http {
  access_log off;
  client_body_temp_path $WORK/nginx-tmp;
  server {
    listen 127.0.0.1:18083;
    root $WORK/data/nginx;
    location /Lumen/ { dav_methods PUT DELETE MKCOL COPY MOVE; create_full_put_path on; dav_access user:rw; }
  }
}
EOF
  nginx -c "$WORK/nginx.conf" && wait_for http://127.0.0.1:18083/ && entries+=('{"name":"nginx (dav module)","kind":"webdav","url":"http://127.0.0.1:18083/Lumen/"}')
fi

if command -v go > /dev/null; then
  mkdir -p "$WORK/data/godav/Lumen"
  cp -r "$HERE/gowebdav" "$WORK/gowebdav-src"
  (cd "$WORK/gowebdav-src" && go mod tidy && go build -o "$WORK/gowebdav" .) &&
    { "$WORK/gowebdav" 127.0.0.1:18084 "$WORK/data/godav" tal pw > "$WORK/godav.log" 2>&1 & PIDS+=($!); } &&
    wait_for http://127.0.0.1:18084/ && entries+=('{"name":"golang.org/x/net/webdav","kind":"webdav","url":"http://127.0.0.1:18084/Lumen/","username":"tal","password":"pw"}')
fi

if [ ${#entries[@]} -eq 0 ]; then echo "No server is installed; see the comment at the top of this script." >&2; exit 1; fi
(IFS=,; echo "{\"servers\":[${entries[*]}]}") > "$SERVERS"
echo "servers: $SERVERS"
cd "$ROOT"
LUMEN_REAL_SERVERS="$SERVERS" LUMEN_REAL_SERVERS_OUT="$WORK/results.json" npx vitest run src/__tests__/providersRealServers.test.ts
node scripts/real-servers/table.mjs "$WORK/results.json"
