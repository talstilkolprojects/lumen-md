# Lumen encrypted sync: protocol specification

Version 1, with the keyring of plan W1.7. Status: **open for public review**
(see the last section). This document is normative: a reader written only
from it must open every vault in [`sync-protocol-vectors.json`](sync-protocol-vectors.json).
`scripts/sync-protocol/check_vectors.py` is such a reader. It is about 250
lines of Python on the `cryptography` package and shares no code with
Lumen.

Notation: `b64u` is base64url without padding, `b64` standard base64 with
padding. `HKDF(ikm, salt, info)` is HKDF-SHA256 with a 32-byte output.
`HMAC` is HMAC-SHA256. Strings are UTF-8.

## 1. The provider

A sync provider (WebDAV, S3, Dropbox, Google Drive, the LAN host) is a
flat set of named objects with conditional writes (If-Match /
If-None-Match). Syncing works on a provider that ignores them (a lost race
costs a round), but key and device changes (§5) are made only on one that
has proved them: a client creates `lumen-e2ee-cas-probe` create-only, checks
a second create-only write and a write with the stale etag are both refused
and left the object unchanged, then deletes it. It sees only:

| Object | Name | Contents |
|---|---|---|
| Header | `lumen-e2ee-vault` | JSON, in the clear but MACed (§2) |
| Keyring | `lumen-e2ee-keyring` | JSON with encrypted fields (§5); absent at epoch 0 |
| Manifest | `b64u(HMAC(names, label))` | a sealed object (§4); `label` is `"manifest"` at epoch 0, else the random label the keyring names (§5) |
| Probe | `lumen-e2ee-cas-probe` | one byte, only while a client checks the conditional writes (above) |
| Blobs | `b64u(HMAC(names, "blob\0" + path + "\0" + rev))` | sealed objects |

Every non-fixed name is 43 characters long, the same for every object.

## 2. Header and passphrase

```json
{"format":"lumen-e2ee","protocol":1,"vaultId":"<b64u 16 random bytes>","kdf":{…},"mac":"<b64u>"}
```

`kdf` is one of the following. The key order is part of the MAC input.

- `{"alg":"argon2id","memoryKiB":47104,"iterations":1,"parallelism":1,"salt":"<b64u ≥16 bytes>"}`.
  This is Argon2id version 0x13 (RFC 9106), with a 32-byte tag and no
  secret or associated data. New vaults get these parameters (OWASP 2023).
  Readers refuse memory below 7 MiB, and memory × iterations below 37 MiB.
- `{"alg":"pbkdf2-sha256","iterations":600000,"salt":"…"}`. PBKDF2-HMAC-SHA256
  with at least 600,000 iterations.

`master = KDF(NFC(passphrase))`, 32 bytes. Then, with `salt = vaultId` (its
b64u text, as UTF-8):

- `header = HKDF(master, vaultId, "lumen-e2ee/1/header")`
- `wrap = HKDF(master, vaultId, "lumen-e2ee/1/keyring-wrap")`
- `mac = b64u(HMAC(header, JSON.stringify([format, protocol, vaultId, kdf])))`.
  The JSON has no whitespace and non-ASCII characters are not escaped. A
  wrong MAC means a wrong passphrase or a changed header, and the vault is
  refused.

## 3. Epochs and keys

An *epoch secret* `S` (32 bytes) gives, with `salt = vaultId`:

| Key | info | Use |
|---|---|---|
| manifest | `lumen-e2ee/1/manifest` | AES-256-GCM, the manifest |
| blobs | `lumen-e2ee/1/blobs` | AES-256-GCM, file contents |
| pairing | `lumen-e2ee/1/pairing` | HMAC, pairing codes |
| keyring | `lumen-e2ee/1/keyring` | AES-256-GCM, the keyring's sealed part |

**Epoch 0** is the vault before any re-key, with `S0 = master`. The **names**
key is always `HKDF(S0, vaultId, "lumen-e2ee/1/names")`, so blob names
never change. Every device ever enrolled holds it, so a manifest's name must
not be guessable from it: epochs ≥ 1 name their manifest with a random label
(§5).

## 4. Sealed objects

```
sealed = 0x01 ‖ nonce (12 random bytes) ‖ AES-256-GCM(key, nonce, padded, aad)
aad    = "lumen-e2ee/1/" + kind + "/" + vaultId + "/" + objectName      (kind: "manifest" | "blob")
padded = uint32_be(len(data)) ‖ data ‖ zeros
```

The padded length is a multiple of 256 bytes. Above 4 KiB it is a multiple
of 1/16 of the next power of two.

The **manifest** plaintext is JSON:
`{protocol, vaultId, counter, files: {path: entry}, history: [[counter, sha256hex], …]}`.
Each entry is `{ver, rev, hash: sha256hex(plaintext), size, by, deleted?, e?}`.
`e` is the epoch the blob was sealed in; it is absent for epoch 0.
`counter` goes up by one on every write. A device refuses a lower counter,
and an equal counter with a different digest (rollback / fork).

A manifest with `"protocol":2` also has `frozen: {epoch, at, by}`, and only
then: a re-key to `epoch` has frozen it (§5). Its files are its
predecessor's; it is never a device's freshness anchor. A device writes over
a frozen manifest only once the keyring lists the frozen manifest's digest in
`aborted` (§5). Readers accept protocol 1 and 2 only, and a manifest whose
`vaultId` is another vault's is refused.

## 5. The keyring (plan W1.7)

```json
{"format":"lumen-e2ee-keyring","protocol":2,"vaultId":"…","epoch":N,
 "passphrase":{"n":"<b64u 12>","c":"<b64u>"},
 "devices":{"<id>":{"recipient":"age1…","wrap":"<b64u age file of S_N>"}},
 "sealed":{"n":"…","c":"…"},
 "header":"<b64u>", "prev":"<b64u>"}
```

- `passphrase` is `AES-256-GCM(wrap, n, S_N, aad = "lumen-e2ee-keyring/2/<vaultId>/<N>/passphrase")`.
- `devices[id].wrap` is an **age** v1 file (age-encryption.org/v1) to the
  device's X25519 recipient. Its plaintext is `S_N`. Nothing in this map is
  trusted: it only lets a device find its own wrap.
- `sealed` is `AES-256-GCM(keyring_N, n, JSON contents, aad = "…/2/<vaultId>/<N>/sealed")`, with
  `contents = {older, revoked, devices, manifest, rev, parent, chain, carry?, header?, aborted?}`:
  - `older`: `{"<epoch>": b64u(S)}`, every earlier epoch's secret, `"0"`
    included, so blobs of any epoch stay readable.
  - `revoked`: `[{device, epoch, at, recipient?}]`.
  - `devices`: `{"<id>": "age1…"}`, the **authenticated** list of enrolled
    devices: the only list a re-key wraps for. A reader opening with a
    device key checks it is on it, with that recipient, and not in `revoked`.
  - `manifest`: this epoch's manifest label, `"manifest/<N>/" + b64u(16 random bytes)`.
  - `rev`: the revision at this epoch, 0 for a new epoch and + 1 for each
    rewrite at the same epoch (an enrollment, a called-off re-key, a
    finished passphrase change).
  - `parent`: the digest (below) of the keyring this one replaced, `null`
    for the first keyring. `chain`: `[[epoch, rev, digest], …]` of the
    keyrings before this one, oldest first, at most 64; its last entry is
    `parent`, and for `rev > 0` it is `[N, rev − 1, parent]`.
  - `carry`: `{label, epoch, digest}` of the previous epoch's frozen
    manifest this epoch's manifest was made from.
  - `header`: during a passphrase change, the SHA-256 of the new header,
    whose bytes the file carries as `"header"`, together with `"prev"`, the
    keyring this one replaced (its bytes, b64u). Both go when the change is
    finished (`rev + 1`).
  - `aborted`: digests of this epoch's frozen manifests whose re-key was
    called off (at most 16).
- The keyring's **digest** is
  `sha256hex(JSON.stringify([format, protocol, vaultId, epoch, passphrase.n, passphrase.c, sealed.n, sealed.c, header ?? null, prev ?? null]))`:
  every checkable field, never the plaintext wraps.
- A keyring of protocol 1, or without a sealed `devices` list, comes from a
  pre-release build. It is refused. The passphrase may reset it: a re-key
  wrapped for the passphrase (and devices it enrolls) only, starting a new
  chain (`chain = [[N, 0, digest]]`).

**Descent.** A device remembers the keyring it verified last, `(epoch, rev,
digest)`, and accepts a keyring only if it descends from it:

- a lower epoch, or a lower `rev` at the same epoch, is a rollback;
- the same epoch and `rev` with another digest is a fork;
- at the same epoch, a keyring this device's `S_N` can't open is a fork;
- at a newer epoch, `older["<its epoch>"]` must be its secret, and `chain`
  must list its `(epoch, rev, digest)`. If `chain` is full (64 entries)
  and starts after it, descent is unproven and the device is no longer
  "verified"; otherwise a missing entry is a fork.

**Re-key** from epoch N. The keyring write is the only commit:

1. **Freeze**: write manifest N once more, `protocol: 2` with `frozen`
   (compare-and-swap).
2. **New manifest**: create manifest N+1 under a fresh random label, the
   frozen one with `counter + 1`, sealed with `S_{N+1}`. Nothing names it yet.
3. **Commit**: write the keyring for N+1, compare-and-swap on the keyring
   the device verified (create-only at epoch 0). The new `S` is random; it is
   wrapped for the passphrase (the same one, or a new one) and for each
   device on the sealed list, except those revoked. If the commit loses, the
   re-keyer deletes the manifest of step 2.
4. **Header** (a passphrase change only): write the new header, then
   rewrite the keyring without `header` and `prev` (`rev + 1`). Until the
   header lands, the new passphrase opens the header the keyring carries,
   and the old passphrase opens epoch N from `prev`, never N+1. Any device
   at N+1 finishes this step.

If the manifest a keyring names is missing or doesn't open, a device
re-creates it from the frozen manifest `carry` names (exactly that digest),
unless that would be behind its own anchor. No blob is ever rewritten.

**Calling a freeze off.** A device that has seen the same frozen manifest
for 10 minutes on its own clock (`at` from another clock is never used)
calls the re-key off: at epoch N ≥ 1 it rewrites the keyring (`rev + 1`)
adding the frozen digest to `aborted`, so the re-keyer's commit, a
compare-and-swap on the keyring, fails; then it writes over the freeze. At
epoch 0 there is no keyring to rewrite: it finishes the re-key itself
(steps 2 and 3, create-only, for the passphrase alone). Blobs replaced by a
commit over a freeze are deleted only by a later round.

**Who may change keys.** Re-keying and enrolling need a device whose state
is verified (it created the vault, was paired, or the user confirmed it,
§6) and a provider that proved its conditional writes (§1).

**Revocation**: a device without a wrap at epoch N+1 can't learn `S_{N+1}`,
so it can't open a manifest written after its revocation. A revoked id or
key is never wrapped for again, and can't be enrolled again. If its user
knows the passphrase, the passphrase changes in the same re-key.

## 6. Pairing codes

`"lumen-pair:2:" + N + ":" + b64u(HMAC(pairing_N, body) ‖ body)`, where `N`
is the issuer's epoch, `pairing_N` that epoch's pairing key (§3, from `S_N`;
the master at epoch 0) and
`body = JSON {vaultId, counter, digest, epoch, ringRev, ringDigest, issuedAt, nonce}`.
A code is valid for 15 minutes. It carries the issuing device's verified
anchors — the manifest `(counter, digest)` and the keyring `(epoch, rev,
digest)`, `ringDigest` `""` at epoch 0 — and no key material. A device that
sees an older epoch than `N` says so (its provider may be replaying keys)
instead of trying the HMAC.

## 7. age

Lumen reads and writes age v1 itself: X25519 and scrypt recipients, the
HMAC header, and STREAM with 64 KiB chunks. Device wraps (§5) and encrypted
backups are age files, so the `age` tool opens them too. The vectors include
X25519 files at the chunk boundaries (0, 1, 65,536 and 65,537 bytes) and a
scrypt file.

## 8. Test vectors

`docs/sync-protocol-vectors.json` contains the following.

- `vaults[]`: every object of a vault, with its passphrase and the expected
  plaintext files and epoch.
  - Vault 1 is epoch 0 with PBKDF2.
  - Vault 2 is Argon2id with production parameters, re-keyed twice, with a
    device enrolled, and one more device enrolled at epoch 2 (keyring 2.1).
    Its blobs come from epochs 0, 1 and 2, and it opens through both the
    passphrase and the device's age identity.
  - Vault 3 (`frozen`): a re-key cut off before its commit. Epoch 1's
    manifest is frozen (protocol 2); an orphan epoch-2 manifest is there too.
  - Vault 4 (`pending`): a passphrase change cut off before its header. The
    new passphrase opens epoch 2 through the header the keyring carries; the
    old one opens epoch 1 through `prev`.
- `argon2id[]`: password, salt, parameters and tag, including the production
  parameters.
- `age[]`: X25519 and scrypt files with their plaintext.
- `pairing[]`: codes for vault 1 (epoch 0) and vault 2 (epoch 2, keyring
  revision 1), with their bodies.

```sh
python3 scripts/sync-protocol/check_vectors.py      # the independent reader: 25/25
npx vitest run src/__tests__/e2eeVectors.test.ts    # Lumen's own reader, same file
```

## 9. Threat model in one paragraph

The provider is untrusted. It sees object names of a fixed length, padded
sizes, timing and the header's KDF parameters. It can withhold, replay or
delete objects. Withholding and deleting are denial of service. A replay is
detected by a device that has an anchor — it created the vault, was paired,
or saw the vault before — through the manifest counter and history and the
keyring chain (§5); pairing codes carry both anchors. It can't read, forge
or reorder content. **Inherent limit:** a device opened with the passphrase
alone and never paired has no anchor, so the provider can show it an old
state, an old epoch included (with the old passphrase, the epoch before a
passphrase change, through an old keyring that still carries `prev`). Such a
device says "freshness not verified", may write under that old epoch's keys
(which a device revoked since can read), and can't re-key or enroll. A device holding the
current keys is trusted for that epoch; revocation ends that at the next
epoch. Not covered: a device that is compromised *while* it is enrolled
(it can read what it can sync), metadata (sizes, timing, how many objects),
and the provider's own access controls.

## 10. Public review

Please review this. Findings go to the repository's Discussions (category
*Security*) or, for anything exploitable, through SECURITY.md. Each version
of the spec names its changes here.

Changes:

- Review 12.11: the device list is sealed in the keyring, and revoked
  devices are never wrapped for. Each epoch has its own manifest object. A
  re-key freezes, commits and then finishes, so a cut-off re-key leaves the
  vault openable. Frozen manifests use protocol 2.
- Re-review 12.11: keyring protocol 2. Pre-release keyrings (no sealed list)
  are refused, with a passphrase reset. A keyring names its parent, revision
  and chain, and devices accept only descendants. Manifest labels are random.
  The new manifest is written before the keyring, which is the only commit; a
  freeze is called off through the keyring, on the waiting device's own
  clock. `lumen-e2ee-keyring.prev` is gone: the keyring carries `prev` until
  the passphrase change is finished. Pairing codes (version 2) carry the
  keyring anchor under the epoch's pairing key. Key and device changes need a
  verified device and proven conditional writes. §9 states which devices
  detect a replay.
