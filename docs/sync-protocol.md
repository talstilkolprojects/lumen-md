# Lumen encrypted sync: protocol specification

Version 1, with the keyring of plan W1.7. Status: **open for public review**
(see the last section). This document is normative: a reader written only
from it must open every vault in [`sync-protocol-vectors.json`](sync-protocol-vectors.json).
`scripts/sync-protocol/check_vectors.py` is such a reader. It is about 150
lines of Python on the `cryptography` package and shares no code with
Lumen.

Notation: `b64u` is base64url without padding, `b64` standard base64 with
padding. `HKDF(ikm, salt, info)` is HKDF-SHA256 with a 32-byte output.
`HMAC` is HMAC-SHA256. Strings are UTF-8.

## 1. The provider

A sync provider (WebDAV, S3, Dropbox, Google Drive, the LAN host) is a
flat set of named objects with conditional writes (If-Match /
If-None-Match). It sees only:

| Object | Name | Contents |
|---|---|---|
| Header | `lumen-e2ee-vault` | JSON, in the clear but MACed (§2) |
| Keyring | `lumen-e2ee-keyring` | JSON with encrypted fields (§5); absent at epoch 0 |
| Previous keyring | `lumen-e2ee-keyring.prev` | only while a passphrase change writes its header (§5) |
| Manifest | `b64u(HMAC(names, label))` | a sealed object (§4); `label` is `"manifest"` at epoch 0, else named by the keyring (§5) |
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
key is always `HKDF(S0, vaultId, "lumen-e2ee/1/names")`, so object names
never change.

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

A manifest with `"protocol":2` also has `frozen: {epoch, at, by}`: a re-key
to `epoch` has frozen it (§5). A device writes over a frozen manifest only
when the keyring still has not reached `epoch` and `at` (milliseconds) is
more than 10 minutes old. Readers of protocol 1 alone refuse it.

## 5. The keyring (plan W1.7)

```json
{"format":"lumen-e2ee-keyring","protocol":1,"vaultId":"…","epoch":N,
 "passphrase":{"n":"<b64u 12>","c":"<b64u>"},
 "devices":{"<id>":{"recipient":"age1…","wrap":"<b64u age file of S_N>"}},
 "sealed":{"n":"…","c":"…"}}
```

- `passphrase` is `AES-256-GCM(wrap, n, S_N, aad = "lumen-e2ee-keyring/1/<vaultId>/<N>/passphrase")`.
- `devices[id].wrap` is an **age** v1 file (age-encryption.org/v1) to the
  device's X25519 recipient. Its plaintext is `S_N`.
- `sealed` is `AES-256-GCM(keyring_N, n, JSON contents, aad = "…/<N>/sealed")`, with
  `contents = {older: {"<epoch>": b64u(S)}, revoked: [{device, epoch, at, recipient?}], devices: {"<id>": "age1…"}, manifest: "manifest/<N>", carry: {label, epoch, digest}, header?: sha256hex}`.
  - `older` holds every earlier epoch's secret, `older["0"]` included, so
    blobs of any epoch stay readable.
  - `devices` is the **authenticated** list of enrolled devices. The
    plaintext `devices` map only lets a device find its own wrap; a reader
    opening with a device key checks that it is on the sealed list and not
    in `revoked`.
  - `manifest` is the label of this epoch's manifest object (§1).
  - `carry` names the previous epoch's frozen manifest (its label, epoch and
    plaintext SHA-256) that this epoch's manifest is re-sealed from.
  - `header` is set by a passphrase change: the SHA-256 of the new header,
    whose bytes the keyring carries as `"header": "<b64u>"` until written.
- Keyrings written before review 12.11 have only `older` and `revoked`. Their
  manifest label is `"manifest"`, and the first device that opens one with
  the current secret seals the plaintext device list (minus revoked ids and
  keys, minus entries that are not an age X25519 file) into `devices`.

**Re-key** from epoch N, in this order. Each step is a single write, and
any device can open the vault after each one.

1. **Freeze**: write manifest N once more with `protocol: 2` and `frozen`,
   with compare-and-swap.
2. **Commit**: write the keyring for N+1 with compare-and-swap. The new `S` is
   random, and it is wrapped for the passphrase (the same one, or a new one)
   and for each device on the sealed `devices` list, except those revoked.
   `carry` holds the frozen manifest's digest. If the freeze no longer stands,
   or is more than 5 minutes old, the re-key stops before this step.
3. **Header** (a passphrase change only): before step 2, the previous keyring
   is copied to `lumen-e2ee-keyring.prev`; now the new header is written,
   and that copy deleted. Until the header lands, the new passphrase opens
   the header carried in the keyring, and the old passphrase opens epoch N
   from the copy, never N+1.
4. **Manifest**: write manifest N+1 (`label` = `manifest/<N+1>`), the
   frozen one with `counter + 1`, create-only.

Steps 3 and 4 are idempotent. A device at N+1 that finds them undone does
them itself, and it re-seals only the exact frozen manifest named by
`carry`. No blob is rewritten.

**Revocation**: a device without a wrap at epoch N+1 can't learn `S_{N+1}`,
so it can't open a manifest written after its revocation. A revoked id or
key is never wrapped for again, and can't be enrolled again. If its user
knows the passphrase, the passphrase changes in the same re-key.

**Rollback**: a device remembers the highest epoch it has seen, and refuses
a keyring with a lower one.

## 6. Pairing codes

`"lumen-pair:1:" + b64u(HMAC(pairing, body) ‖ body)`, where
`body = JSON {vaultId, counter, digest, issuedAt, nonce}`. A code is valid
for 15 minutes. It carries the issuing device's verified manifest anchor,
and no key material.

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
    device enrolled. Its blobs come from epochs 0, 1 and 2, and it opens
    through both the passphrase and the device's age identity.
- `argon2id[]`: password, salt, parameters and tag, including the production
  parameters.
- `age[]`: X25519 and scrypt files with their plaintext.
- `pairing`: a code for vault 1, with its body.

```sh
python3 scripts/sync-protocol/check_vectors.py      # the independent reader: 16/16
npx vitest run src/__tests__/e2eeVectors.test.ts    # Lumen's own reader, same file
```

## 9. Threat model in one paragraph

The provider is untrusted. It sees object names of a fixed length, padded
sizes, timing and the header's KDF parameters. It can withhold, replay or
delete objects. Withholding and deleting are denial of service. A replay is
detected through the manifest counter and history, the keyring epoch and
pairing codes. It can't read, forge or reorder content. A device holding the
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
