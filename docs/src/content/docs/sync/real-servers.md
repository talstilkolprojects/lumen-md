---
title: Real servers and conditional writes
description: Which WebDAV and S3 servers keep compare-and-swap, measured against the real servers, and how to run the same check against yours.
---

Encrypted sync replaces the manifest and the keyring only with a
**conditional write**: "replace it if it is still the version I read"
(`If-Match`) or "create it only if nothing is there" (`If-None-Match: *`).
That is what keeps two devices from overwriting each other, and what makes a
key change or a revoked device safe (see [Keys, rotation and
revocation](/sync/e2ee-keys/)).

When you connect a storage, Lumen **probes** it: it writes a few random
objects and checks that a stale `If-Match` and a second create-only write are
refused, that each write gets a new ETag, and that racing creates have exactly
one winner. A server that fails the probe is refused. Before every key or
device change the engine probes again.

## What we measured

These runs use the real servers, not mocks, on 12 November 2026
(`src/__tests__/providersRealServers.test.ts`, plan W6.27). A race is 4
writers at once; the counts are rounds with exactly one winner (100 rounds,
500 for moto). "Probe" is how often the connect probe accepted the server in
200 tries.

| Server | Probe | Create-only refused | Stale If-Match refused | Racing creates | Racing replaces | Key change |
|---|---|---|---|---|---|---|
| moto 5.2.5 (S3 API) | 199/200 | ✅ | ✅ | ⚠️ 499/500 | ✅ 500/500 | allowed; the stale re-key is refused |
| WsgiDAV 4.4.0 | 0/200 | ✅ | ❌ | ❌ 92/100 | ❌ 30/100 | refused |
| sabre/dav 4.7.1, file-system backend | 0/200 | ✅ | ❌ | ❌ 98/100 | ❌ 10/100 | refused |
| golang.org/x/net/webdav 0.47 (used by rclone, hacdias/webdav) | 0/200 | ❌ | ❌ | ❌ | ❌ | refused |
| nginx 1.31 `dav` module | 0/200 | ❌ | ❌ | ❌ | ❌ | refused (no vault) |

What the results mean:

- **moto** is a test double of the S3 API, not a storage service. It keeps
  `If-Match`, but one round in 500 let two create-only writes win, and the
  probe passed it 199 times in 200. No probe can prove a create is atomic; it
  can only make a racy one likely to show. This is why the engine also reads
  every keyring write back (spec §9). AWS S3, MinIO and R2 still have to be
  measured.
- **WsgiDAV and sabre/dav's file-system backend** check `If-Match` and
  `If-None-Match`, but their ETag is the file's modification time in whole
  seconds plus its size. Two writes of the same size in one second get the same
  ETag, so a stale `If-Match` is accepted. They also check and write in two
  steps, so racing writers can both win. Nextcloud is built on sabre/dav but
  uses its own ETags and file locks; it has to be measured on its own (below).
- **golang.org/x/net/webdav** ignores both headers on `PUT`. It answers `423
  Locked` to a write that overlaps another.
- **nginx's `dav` module** ignores both headers, returns no ETag on `PUT` and has
  no `PROPFIND` without a third-party module.

The probe used to write once and race two writers once. Against WsgiDAV it
then passed 11 times in 200, and against sabre/dav 6 in 200: whenever its
writes happened to straddle a second. It now replaces three times in a row and
races four writers three times, and accepted neither server in 200 tries.

**Still to measure** (they need Docker or an account): Nextcloud, Apache
`mod_dav`, MinIO, Dropbox and Google Drive. Google Drive is sync-only whatever
the result: its create-only write is not atomic, so key and device changes are
always refused on it.

## Run it against your server

The test runs only when `LUMEN_REAL_SERVERS` names a file of servers:

```bash
cat > /tmp/servers.json <<'EOF'
{ "servers": [
  { "name": "my Nextcloud", "kind": "webdav", "url": "https://cloud.example.com/remote.php/dav/files/me/", "username": "me", "password": "an app password" },
  { "name": "my bucket", "kind": "s3", "endpoint": "https://s3.eu-central-1.amazonaws.com", "region": "eu-central-1", "bucket": "my-bucket", "accessKeyId": "…", "secretAccessKey": "…" }
] }
EOF
LUMEN_REAL_SERVERS=/tmp/servers.json LUMEN_REAL_SERVERS_OUT=/tmp/results.json \
  npx vitest run src/__tests__/providersRealServers.test.ts
node scripts/real-servers/table.mjs /tmp/results.json
```

It works in a new folder or prefix (`lumen-real-<run>-…`) and deletes the
objects it writes. The test fails when the probe and the server disagree: the
probe accepts a server that fails a case, or refuses one that passes them all.

- `scripts/real-servers/local.sh` starts the servers installed on this machine
  (WsgiDAV, moto, nginx, the Go server) and runs the test.
- `scripts/real-servers/docker-compose.yml` starts Nextcloud, Apache `mod_dav`
  and MinIO; `servers.docker.json` lists them.
- `scripts/real-servers/cloud.sh` runs Dropbox and Google Drive with a token
  you make yourself. The steps are at the top of the file.
