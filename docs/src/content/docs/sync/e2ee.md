---
title: Encrypted sync (E2EE)
description: The end-to-end encrypted sync protocol — what is encrypted, what the sync service sees, rollback protection and its trust-on-first-use limit.
---

Encrypted sync keeps a copy of your vault at a storage service (Dropbox,
Google Drive, WebDAV, S3 — the providers arrive with plan 3.5) so that the
service stores **only ciphertext under random-looking names**. Your notes
are encrypted on your device before they leave it, with a key derived from
a passphrase that never leaves your devices.

> **Status:** the protocol core is implemented and tested. The key
> derivation is PBKDF2-SHA256 for now; Argon2id is reserved in the format
> and will replace it for new vaults once its library is added. The `age`
> backup export is not available yet.

Everything in the vault is synced — hidden content such as `.github/` or
`.gitignore` included — except the top-level `.trash/` and `.git/` (git's
own internals travel through git sync, not file by file).

## What the sync service sees

| It sees | It does not see |
|---|---|
| One clear-text header: protocol version, a random vault id, the key-derivation algorithm and its salt and iteration count | Your passphrase or any key |
| Encrypted objects, each named by 43 random-looking characters | File and folder names, paths |
| How many objects there are, and roughly how big each one is (sizes are padded to 256-byte buckets, and to within ~6 % above 4 KiB) | File contents, exact sizes |
| When you sync (the times of its own requests) | Version numbers of files, the manifest counter, which device wrote what |

The service can still delete or withhold data, serve an old copy, or show
two devices different copies. Encryption cannot prevent that; the
protocol is designed to **detect** it instead (see below), and nothing is
applied from data that fails to authenticate.

## The protocol (version 1)

**Header.** `lumen-e2ee-vault` holds `{format, protocol, vaultId, kdf, mac}`.
The `mac` is HMAC-SHA256 over the other fields under a key derived from
the passphrase: a wrong passphrase is detected before anything is
decrypted, and a service that edits the header — for example to lower the
iteration count — makes the MAC fail. A client also refuses fewer than
600,000 PBKDF2 iterations (OWASP 2023), and refuses an algorithm it does
not know instead of guessing.

**Keys.** The passphrase (normalised to Unicode NFC, so the same Hebrew
passphrase typed on macOS and Windows gives the same key) goes through the
header's KDF to a 32-byte master key. HKDF-SHA256 derives one key per job:
header MAC, object names, manifest encryption, file encryption, pairing.

**Objects.** Every object is `version byte ‖ 12-byte random nonce ‖
AES-256-GCM(ciphertext + tag)`. The vault id and the object's name are
bound in as additional data, so the service cannot swap two objects or move
one between vaults without decryption failing. Plaintext is length-prefixed
and padded before encryption.

**Manifest.** One encrypted object lists every file: its own version
number (1, 2, 3… per path, deletions included), a random revision id, the
SHA-256 of its plaintext and a deletion marker. It also carries the
protocol version and a **counter** that goes up by one on every write. The
manifest's name is the same for every version, so the name leaks nothing.

**File objects.** A version of `notes/a.md` is stored under
HMAC(`notes/a.md`, revision id). Each version gets a fresh name and is
never overwritten, which is what lets two devices upload at the same time
without destroying each other's data.

**A sync round.**

1. Read the manifest and its revision (ETag); decrypt and authenticate it;
   check it is not older than what this device has already seen.
2. Pull: apply every change made elsewhere; settle conflicts.
3. Push: upload each local change as a new file object, then write the new
   manifest (counter + 1) **only if the manifest is still at the revision
   read in step 1** (compare-and-swap: `If-Match` / Dropbox `rev`).
4. If another device wrote in between, the write is refused: go back to 1,
   pull its changes, merge, and try again. Both devices' changes end up in
   the manifest; neither overwrites the other.

A round cut off at any point loses nothing: file objects are uploaded
before the manifest that names them, and the next round recognises work
that already happened. Objects a round uploaded but never committed, and
objects replaced by a newer version, are deleted later; objects the device
does not know about are never touched (they may be another device's upload
in progress).

**Conflicts.** If only one side changed a file, or both made the same
change, there is nothing to ask. An edit always wins over a deletion it
did not see. When both sides edited a note differently, the three-way
conflict dialog opens (merge, keep mine, take theirs, or decide later —
the note then stays as it is on both sides until the next sync). Binary
files keep both versions: yours at the path and the other one as
`name (conflict <date> <device>).ext`.

A path a device cannot hold — a name its system refuses (a `:` in a file
name on Windows), or a file and a folder of the same name on the two sides —
is **held**: it is listed as not synced, stays untouched on both sides, and
everything else keeps syncing. A held clash never reaches the manifest
either, so it never describes both a file `x` and notes inside a folder `x/`.

## Rollback and replay protection

Every device remembers the highest manifest counter it has verified, and
the digest of that manifest. It refuses:

- a manifest with a **lower** counter — the service replaying an old state
  (which would silently undo your recent edits);
- a manifest with the **same** counter but different content — a fork;
- a manifest with a **higher** counter that does not descend from the one
  it trusted: every manifest lists its last 100 predecessors (counter and
  digest), and the trusted one must be among them with the same digest —
  otherwise it is another branch (a fork), not an update. A device more
  than 100 versions behind cannot check this, so it drops back to
  "freshness not verified" instead of claiming protection;
- a missing manifest once it has seen one.

Only someone with the passphrase-derived key can produce a manifest that
authenticates, so the counter cannot be forged by the service. This uses
the AEAD tag and HMACs, not public-key signatures, on purpose: every device
that can sync holds the same key, and the adversary is the service, which
has none. A signature would only tell your devices apart from each other —
something a shared passphrase cannot offer anyway, and not in this threat
model.

## New devices: pairing, or trust on first use

A device that has never seen the vault cannot know which manifest is the
newest — the service could show it an old one from the start. So:

- **Pairing (verified).** On a device you already use, create a pairing
  code (shown as text or a QR code). Enter it on the new device. The code
  carries the newest counter and manifest digest the existing device has
  verified, authenticated with an HMAC under the vault's pairing key, valid
  for 15 minutes. It goes from device to device, never through the sync
  service, and contains no key: the new device still needs the passphrase.
  From then on the new device rejects anything older.
- **Without pairing (TOFU — not verified).** The new device accepts the
  first manifest it is shown (*trust on first use*). It does refuse
  anything older than that afterwards, but if the very first manifest was
  already stale it cannot notice. Lumen therefore shows **"Freshness not
  verified"** on that device and claims no rollback protection until you
  pair it or confirm by hand (for example after checking that a recent
  note is there). A pairing code older than the state the new device already holds is
  refused (it cannot vouch for a newer manifest). An unverified device cannot issue pairing codes: it
  would pass a state nobody verified to the next device as "paired".

## What this does not protect against

- Someone who knows your passphrase, or controls one of your unlocked
  devices.
- A weak passphrase: the iteration count slows guessing, it does not make
  a short passphrase strong. Use a long one; it cannot be recovered if lost.
- The service deleting your data or refusing to serve it (keep a local
  copy — your vault on each device is a full copy).
- Two devices being shown different but valid histories forever (a
  permanent fork) is detected only when they compare notes — by pairing or
  by syncing through the same up-to-date copy.
- Traffic analysis: sync times, object counts and size buckets are visible.
