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

A re-key commits in a single write: the new keyring. The new manifest is
written just before it, under a random name nobody can guess. If the
connection drops or the tab closes partway, nothing breaks:

- **Before the keyring is written**, devices keep downloading changes, and
  their own changes wait. Run the re-key again. If it isn't, each device
  waits 10 minutes on its own clock, then calls the re-key off in the
  keyring and goes on; a late commit of that re-key is then refused.
- **During a passphrase change**, the old passphrase keeps opening the vault
  until the new one is fully in place, but only at the keys from before the
  change. Once the new header is written, the next device that syncs removes
  that way back, and only the new passphrase opens the vault.

Tested on a vault of 10,000 notes (3 objects written, every note readable
after), and over 10,000 random sync rounds with 40 re-keys and revocations
in between, with 0 lost.

## Who can change the keys

- **A verified device.** Only a device that created the vault, was paired
  with a pairing code, or that you confirmed by hand can re-key or enroll a
  device. A device opened with the passphrase alone syncs, but the storage
  could be showing it old keys, so it can't change them until you pair it.
  Pairing codes carry the keys' version too: a device that is shown old keys
  is told so when you pair it.
- **A storage that refuses stale writes.** Before it changes keys, Lumen
  checks that the storage refuses a write based on an outdated version. One
  that doesn't (some WebDAV servers) can still sync, but Lumen won't re-key,
  revoke or enroll there, because two devices could change the keys at once
  without either noticing.
- **The keys must line up.** Every keyring names the one before it. A device
  refuses a keyring that doesn't follow from the last one it checked, and
  says so, instead of quietly using different keys.

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

One limit is built in: a brand-new device that you open with the passphrase
alone and never pair can be shown the vault as it was before the removal,
and what it writes then is readable by the removed device. Pair new devices
from one you already use.

## age

Device keys, and the encrypted backups of plan W1.6, use the **age** file
format. The `age` command-line tool opens them, and Lumen opens files made
by `age`.

## Keys from a pre-release build

A keyring written by a pre-release build of the encrypted sync has no sealed
device list, so Lumen refuses it ("written by a pre-release build"). With the
passphrase you can reset it: unlock with the reset option, then re-key. The
new keys are wrapped for the passphrase only, and you enroll each device
again.

## The spec and the test vectors

`docs/sync-protocol.md` in the repository describes the format so exactly
that someone else can implement it. `docs/sync-protocol-vectors.json` holds
whole vaults (epoch 0 with PBKDF2; an Argon2id vault re-keyed twice with
devices; one with a re-key cut off before it committed; one with a
passphrase change cut off before its header) plus Argon2id, age and pairing
vectors. An independent Python
reader (`scripts/sync-protocol/check_vectors.py`) decodes all of them
identically. Review is welcome in the repository's Discussions.
