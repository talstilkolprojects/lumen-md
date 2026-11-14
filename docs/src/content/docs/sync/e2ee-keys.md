---
title: Keys, rotation and revocation
description: Argon2id, age interop, key rotation without re-uploading, removing a lost device, and the public protocol spec.
---

The [encrypted sync](/sync/e2ee/) has four more parts since plan W1.7.

## Argon2id

A new vault derives its key from the passphrase with **Argon2id** (RFC 9106,
46 MiB, one pass), OWASP's first recommendation. It runs in plain TypeScript
in every browser and takes about a second. A faster WebAssembly build can be
plugged in, and must give the same bytes. Vaults made with PBKDF2 keep
working as before.

## Rotating the keys

A re-key starts a new **epoch** with fresh random key material, wrapped for
your passphrase (and, if you like, a new one) and for each enrolled device.
Only the keyring and the manifest are rewritten. **No note is downloaded or
uploaded again**: older notes keep the key of the epoch they were written in,
and that key is sealed inside the new epoch.

A re-key commits in a single write: the new keyring. If the connection drops
or the tab closes partway, nothing breaks:

- **Before the keyring is written**, devices keep downloading changes, and
  their own changes wait. Run the re-key again. After 10 minutes, the other
  devices go on without it.
- **After the keyring is written**, the next device that syncs finishes the
  re-key.
- **During a passphrase change**, the old passphrase keeps opening the vault
  until the new one is fully in place, but only at the keys from before the
  change. After that, only the new passphrase opens it.

Tested on a vault of 10,000 notes (3 objects written, every note readable
after), and over 10,000 random sync rounds with 40 re-keys and revocations
in between, with 0 lost.

## Removing a lost device

A device can be enrolled with its own key (an age X25519 key pair), so it
opens the vault without the passphrase. To remove a lost device, re-key and
leave it out. It then can't open any manifest written after that, because
the new epoch was never wrapped for it. If whoever has the device also knows
the passphrase, change the passphrase in the same re-key. A device can't
be handed an old keyring either: every device remembers the newest epoch it
has seen.

The list of enrolled devices is sealed with the vault's keys, so the sync
provider can't add a device of its own or bring back a removed one. A removed
device can't be enrolled again under its old name or key either: enroll it
as a new device with a new key.

## age

Device keys, and the encrypted backups of plan W1.6, use the **age** file
format. The `age` command-line tool opens them, and Lumen opens files made
by `age`.

## The spec and the test vectors

`docs/sync-protocol.md` in the repository describes the format so exactly
that someone else can implement it. `docs/sync-protocol-vectors.json` holds
whole vaults (epoch 0 with PBKDF2, and an Argon2id vault re-keyed twice with
a device) plus Argon2id, age and pairing vectors. An independent Python
reader (`scripts/sync-protocol/check_vectors.py`) decodes all of them
identically. Review is welcome in the repository's Discussions.
