---
title: Sync providers
description: Where the encrypted vault can live — WebDAV, S3-compatible storage, Dropbox, Google Drive — how to connect each, what each server must support, and how notes from the old plain-text sync are moved into the vault.
---

[Encrypted sync](/sync/e2ee/) keeps a copy of your vault at a storage
service. The service only ever stores ciphertext under random-looking names,
so you can use storage you do not fully trust. Open it from the command
palette: **Encrypted sync…**.

| Provider | Good for | Status |
|---|---|---|
| **WebDAV** | Nextcloud, ownCloud, a Synology/QNAP NAS, any WebDAV server | Available |
| **S3-compatible** | AWS S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi | Available |
| **Dropbox** | An existing Dropbox account | Needs Lumen's Dropbox app key. Not configured in the public builds yet |
| **Google Drive** | An existing Google account | Needs Lumen's Google client id. Not configured in the public builds yet |

> **Status:** the four providers are tested against mock servers that
> implement each service's conditional write (see *Why conditional writes*
> below), including two devices racing to write at the same time. The real
> Dropbox and Google Drive have **not** been tested yet: that needs Lumen's
> own app registrations with Dropbox and Google, which do not exist yet. A
> self-hosted build can set `VITE_DROPBOX_APP_KEY` / `VITE_GDRIVE_CLIENT_ID`
> to its own.

## Connecting

1. Open **Encrypted sync…** and pick a provider.
2. Fill in its details (below) and press **Connect**. Lumen checks the
   credentials and checks that the server supports safe concurrent writes.
   If it does not, Lumen refuses to sync with it, so a race can never lose a
   note.
3. If there is no vault there yet, choose a passphrase (at least 12
   characters) to create one. If a vault exists, enter its passphrase.
4. The first sync runs. After that Lumen syncs every 5 minutes while the
   vault is unlocked, when the device comes back online, and whenever you
   press **Sync now**.

The passphrase is never stored. After a reload Lumen asks for it again.
The WebDAV password and the S3 secret key are kept in Lumen's secret store
on this device, encrypted at rest where the platform allows it.
**Disconnect** forgets the provider on this device. It deletes nothing at
the provider.

### WebDAV

- **Folder address:** the full URL of a folder for Lumen, for example
  `https://cloud.example.com/remote.php/dav/files/<you>/Lumen/` on Nextcloud.
  Lumen creates the folder if it is missing.
- **User name** and **password**. On Nextcloud and ownCloud, use an *app
  password* (Settings → Security), not your login password.

The server must return an `ETag` for every file and honour `If-Match` and
`If-None-Match: *` on `PUT`. Nextcloud, ownCloud, Apache `mod_dav` and
Synology's WebDAV server do. Lumen tests this when you connect.

### S3-compatible

- **Endpoint:** for example `https://s3.eu-central-1.amazonaws.com`,
  `https://<account>.r2.cloudflarestorage.com` or `https://minio.example.com`.
- **Region** (`auto` for R2), **bucket**, and a **folder inside the bucket**
  (default `lumen/`).
- An **access key ID** and **secret access key** limited to that bucket.
- **Path-style addresses:** on for MinIO and most self-hosted servers.

The service must support conditional writes (`If-None-Match: *` and
`If-Match` on `PutObject`). AWS S3 has supported them since 2024; R2 and
MinIO do too. Lumen checks this when you connect: it makes one write with a
stale `If-Match` and expects a refusal.

### Dropbox and Google Drive

Press **Sign in to Dropbox / Google Drive**. You leave Lumen to approve
access and come back to the panel. Dropbox keeps the vault in
`/Apps/Lumen/vault`. Google Drive keeps it in a folder called
**Lumen Vault**, and Lumen can only see files it created (`drive.file`
scope).

## Using it from a web browser

A browser only lets a page talk to another server when both sides allow
it:

- **The server** must allow Lumen's address (CORS) for the methods
  `GET, PUT, DELETE, PROPFIND, MKCOL`, accept the request headers
  `Authorization, Content-Type, If-Match, If-None-Match, Depth` (plus
  `x-amz-*` for S3), and **expose the `ETag` header**. Nextcloud needs a CORS
  app for this. On S3 and R2 it is a bucket CORS rule.
- **A self-hosted Lumen** must add the server to its Content Security
  Policy. Set `VITE_CSP_CONNECT_EXTRA=https://cloud.example.com` at build
  time (see [Self-hosting with Docker](/self-hosting/docker/)).

When either is missing, Connect says that Lumen *could not reach* the
server. Dropbox and Google Drive are already allowed.

The desktop app has the same Content Security Policy as the web app today.
A WebDAV or S3 server that is not in it cannot be reached from the desktop
app either, until a build adds it.

## Why conditional writes

Two devices can sync at the same moment. Every write Lumen makes says what
it expects to replace (`If-Match` with the version it read, or "only if
absent"). When another device got there first, the server refuses, and
Lumen re-reads, merges and tries again. Without that, the second write
would silently erase the first device's changes. Each provider's mechanism:

| Provider | Mechanism |
|---|---|
| WebDAV | `If-Match: <ETag>` / `If-None-Match: *` → `412` |
| S3 | `If-Match: <ETag>` / `If-None-Match: *` → `412` (or `409` during a concurrent write) |
| Dropbox | `mode: update` with the file's `rev` / `mode: add`, `strict_conflict` → `409 conflict` |
| Google Drive | `If-Match` with the file's ETag → `412`. Drive has no "only if absent" for a new file, so Lumen creates the file and then looks again. If another device created the same file first, Lumen removes its own copy and counts the write as lost. This relies on Drive listing a new file as soon as it has been created. That is untested against the real Drive (see Status) |

## Notes from the old plain-text sync

Earlier Lumen versions could sync notes to Dropbox (`/Apps/Lumen`) and
Google Drive (the **Lumen** folder) as readable files. GitHub Gist sync has
been removed.

When you connect Dropbox or Google Drive and readable notes are still
there, the panel offers **Import and back up**:

1. Every note is imported into your local vault. When a note with the same
   name here has different text, both are kept. The provider's copy arrives
   as `name (from Dropbox).md`.
2. The readable copies are **moved**, not deleted, into
   `lumen-plaintext-backup-<date>/` in the same folder.
3. The next sync uploads the notes encrypted.

If the connection drops halfway, run it again. It continues where it
stopped and does not import a note twice. **Undo** moves the readable copies
back where they were. Once you are satisfied, delete the backup folder
yourself. Until you do, readable copies of those notes stay at the
provider.
