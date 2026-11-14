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

## Pairing a new device

Pair a new device from one you already use, in two steps:

1. On the new device, choose **Show a pairing request**.
2. Enter the request on the device you already use. It checks the request
   against the vault as it is right now and shows an answer; enter the answer
   on the new device.

If the storage is showing the new device old keys (from before a device was
removed, say), the device you already use says so at step 2, and the new
device isn't paired. A one-way pairing code (from the device you already use
to the new one) still works, but only for 2 minutes, and the device that made
it doesn't change keys while it is valid. A request, an answer and a one-way
code are three different kinds of message: one can't be turned into another,
and an answer works only for the request it answers.

**Cancelling a pairing.** The device that answered a request (or made a code)
doesn't change keys for the next 5 minutes (2 for a code). If you must remove a
lost device right away, cancel the pairing on it first (`cancelPairing()`;
in the app, *Cancel pairing*). Then don't use that answer or code on the new
device: pair it again after the key change. Cancelling on the new device
forgets its request, so no answer to it is accepted any more.

Until a new device is paired (or you confirm it by hand), it downloads
changes but **keeps its own changes on the device**: it can't tell yet
whether it has the latest keys, and a device removed meanwhile could read
what it uploads. The banner says so.

## Who can change the keys

- **A verified device.** Only a device that created the vault, was paired,
  or that you confirmed by hand can enroll a device, and only its re-keys
  keep the enrolled devices. A device opened with the passphrase alone can
  re-key, but the storage could be showing it an old device list, so its new
  keys open only with the passphrase: every device with its own key would
  have to be paired again. Lumen asks first, naming those devices, and only
  goes ahead once you confirm. Each of them then says *pair this device
  again*, not *removed*. A device stays verified as long as its keys still
  match the check it keeps, however long it was away.
- **Keys tied to a secret.** Each device remembers the keys it last checked
  together with a check only the vault's keys can make. A device that opens
  with its own key refuses keys the storage made for it, even though the
  storage knows the device's public key.
- **A storage that refuses stale writes.** Before it changes keys, Lumen
  checks that the storage refuses a write based on an outdated version. One
  that doesn't (some WebDAV servers) can still sync, but Lumen won't re-key,
  revoke or enroll there, because two devices could change the keys at once
  without either noticing. **Google Drive** can't refuse a second "create" of
  the same file atomically, so a vault on Drive syncs, but its keys and
  devices are changed with another storage.
- **Each key change is read back.** Right after a re-key, Lumen reads the
  keyring again. If the storage returns another device's key change instead,
  Lumen says *the revocation may not have taken effect*. At its next sync it
  removes the device again on top of the other change, even if that change
  was built on since, and says so.
- **A removal sticks.** The device you removed a device on remembers it. If a
  keyring ever lets that device back in, it removes it again; if it can't, it
  stops and says the removal may have been undone. Every device also
  remembers each removal the vault's signed device list has shown it, so this
  holds after you restore a backup or reinstall and pair again. If a device's
  own list of removals is ever damaged, Lumen sets it aside, keeps checking
  against the signed list, and asks you to check the device list on a device
  you trust.
- **Two key changes don't race.** If another device is in the middle of a key
  change, Lumen waits for it to finish (at most 10 minutes) instead of
  making its own on top. The 10 minutes count from your first try, so a lost
  device that keeps starting key changes of its own can't hold back its
  removal that way. Once the key change you waited on has finished, the
  next one is waited on in full again.
- **A lost device can still block its removal while it has your storage
  login.** It can rewrite the device list every time you try, so the removal
  never goes through. Lumen says so from the second try. That's why the
  steps under *Removing a lost device* start with the storage password.
- **No pairing code during a key change.** While this device is changing
  keys, in any of its tabs, it doesn't make a pairing code or answer: the
  code would be for the keys being replaced. Make it once the change has
  finished. If another tab is only syncing, Lumen says the device is busy:
  try again in a moment. A key change waits at most a few seconds for such
  a tab, then says the same and changes nothing.
- **A new passphrase keeps Argon2id.** A passphrase change keeps the way the
  passphrase is protected, as the vault's signed header says; it never moves
  an Argon2id vault to PBKDF2.
- **The keys must line up.** Every keyring names the one before it. A device
  refuses a keyring that doesn't follow from the last one it checked, and
  says so, instead of quietly using different keys.

## Removing a lost device

A device can be enrolled with its own key (an age X25519 key pair), so it
opens the vault without the passphrase. To remove a lost device:

1. **Change the storage password or token first** (WebDAV, S3, Dropbox or
   Drive), so the lost device can't write to the storage any more. While it
   can, it can keep the removal from going through.
2. Re-key and leave it out. It then can't open any manifest written after
   that, because the new epoch was never wrapped for it. If whoever has the
   device also knows the passphrase, change the passphrase in the same
   re-key. A device can't
be handed an old keyring either: every device remembers the newest epoch it
has seen.

The list of enrolled devices is sealed with the vault's keys, so the sync
provider can't add a device of its own or bring back a removed one. A removed
device can't be enrolled again under its old name or key either: enroll it
as a new device with a new key. To use a removed device with the vault
again, pair it as a new device.

A storage can still keep showing your *other* devices the vault from before
the removal. Each of them then sees a consistent vault, so none of them can
tell, and what they write stays readable by the removed device. Pairing two
devices (above) shows it. After removing a device, pair or sync the others
from the device you removed it on. If a device's key in the keyring doesn't
open it, Lumen says the storage changed it, and changes nothing on the
device.

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
