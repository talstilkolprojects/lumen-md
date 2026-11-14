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
has proved them: a client creates an object under a random 43-character name
with random contents the size of the smallest blob, create-only; checks that
a second create-only write and a write with the stale etag are both refused
and left the object unchanged, and that of two create-only writes racing on
another random name exactly one wins; then deletes both. The probe looks
like any blob upload, so a provider can't single it out by name or size (it
can still by behaviour: the probe proves a storage is configured right, not
that a malicious one keeps the conditions; see §5 *Read-back* and §9). A
provider whose create-only is not atomic (Google Drive: look, create, look
again) is **sync-only**: it syncs, but no key or device change is made on
it. The provider sees only:

| Object | Name | Contents |
|---|---|---|
| Header | `lumen-e2ee-vault` | JSON, in the clear but MACed (§2) |
| Keyring | `lumen-e2ee-keyring` | JSON with encrypted fields (§5); absent at epoch 0 |
| Manifest | `b64u(HMAC(names, label))` | a sealed object (§4); `label` is `"manifest"` at epoch 0, else the random label the keyring names (§5) |
| Probe | random, 43 characters | random bytes, only while a client checks the conditional writes (above) |
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
| anchor | `lumen-e2ee/1/anchor` | HMAC, the check a device keeps with its keyring anchor (§5); never sent |
| dropped | `lumen-e2ee/1/dropped` | HMAC, from `S_{N−1}`: the `dropped` marker of a re-key to epoch N (§5) |
| revoked-here | `lumen-e2ee/1/revoked-here` | HMAC, from `S0` only: the list of devices a device revoked, kept in its own state (§5); never sent |

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
 "header":"<b64u>", "prev":"<b64u>",
 "dropped":[{"epoch":N,"at":ms,"devices":["<id>",…],"mac":"<b64u>"}]}
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
- `dropped` (fifth review 12.11, F4), optional, at most 8: the devices a
  re-key from an unverified device left out (*Who may change keys*), per such
  re-key at epoch `N`, with
  `mac = b64u(HMAC(dropped_{N−1}, JSON ["lumen-e2ee-dropped/1", vaultId, N, at, sorted devices]))`,
  `dropped_{N−1} = HKDF(S_{N−1}, vaultId, "lumen-e2ee/1/dropped")`. A device
  without a wrap that is listed reads "left out: pair again", not "removed";
  a device that holds `S_{N−1}` (one that synced before) believes the marker
  only if `N` is the first epoch it doesn't hold (`N = its epoch + 1`) and
  the MAC verifies, and otherwise reads "removed": an older genuine marker
  the provider kept and put back after a real revocation is refused (seventh
  review 12.11, G2). Later re-keys carry each marker, minus the devices
  enrolled or revoked since (its MAC made again with `S_{N−1}`, which they
  hold in `older`); enrolling a device again removes it from every marker
  the same way. Not in the digest.
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
  and starts after it, descent is unproven; otherwise a missing entry is a
  fork. Unproven descent is not a demotion when the device's anchor check
  (below) verifies: the keys hold the secret of the keyring it verified, and
  the device walks forward on that (fifth review 12.11, F3). Only a device
  without a checked anchor is no longer "verified". The same holds for a
  manifest more than 100 commits ahead of the device's manifest anchor (§4):
  sealed under keys that reproduce the anchor, it is accepted as the new
  anchor.

**Anchors** (third review 12.11, N1). The `(epoch, rev, digest)` a device
remembers is public: the provider can compute every digest. A device opened
with its own age key gets its keys from the keyring's plaintext wrap, which
the provider can also make — for any secret it chose — because the device's
recipient is public. So a device stores, with the anchor,
`check = b64u(HMAC(anchor_E, JSON ["lumen-e2ee-anchor/1", vaultId, epoch, rev, digest]))`,
where `anchor_E = HKDF(S_E, vaultId, "lumen-e2ee/1/anchor")` comes from the
secret of the anchor's epoch `E`. At every open and every round, before
anything else, the keys must reproduce it: at epoch `E` with their own
secret, at a newer epoch with `older["E"]`; keys of an older epoch are a
rollback, keys without that secret (or with one that doesn't reproduce the
check) a fork. This holds for passphrase and device-key devices alike.

**Re-key** from epoch N. The keyring write is the only commit:

1. **Freeze**: write manifest N once more, `protocol: 2` with `frozen`
   (compare-and-swap). If manifest N is already frozen by *another* device
   and the keyring doesn't list it in `aborted`, that is a key change in
   progress (fifth review 12.11, Q2): the re-keyer refuses ("another device
   is changing keys") instead of freezing over it, for at most 10 minutes on
   its own clock. The wait is bounded per key change, not per frozen
   manifest (seventh review 12.11, G1): it runs from this device's first
   refusal (kept in its state, and from the first of an unbroken run of
   foreign freezes its rounds saw), whatever freezes come after, and after
   it the re-keyer freezes over whatever freeze is there. A refusal older
   than 24 hours starts the wait again. Nothing in a freeze (digest, `at`,
   `by`) moves this clock, so the device being revoked, which still holds
   `S_N` and the storage login, can't hold its revocation back by writing a
   fresh freeze every few minutes. Against a provider that keeps the
   compare-and-swap on the manifest but drops it on the keyring, this keeps
   two re-keys from both committing: an honest re-key commits within
   seconds, far inside the wait.
2. **New manifest**: create manifest N+1 under a fresh random label, the
   frozen one with `counter + 1`, sealed with `S_{N+1}`. Nothing names it yet.
3. **Commit**: write the keyring for N+1, compare-and-swap on the keyring
   the device verified (create-only at epoch 0). The new `S` is random; it is
   wrapped for the passphrase (the same one, or a new one) and for each
   device on the sealed list, except those revoked. If the commit loses, the
   re-keyer deletes the manifest of step 2.
   **Read-back** (third review 12.11, N2): the re-keyer then reads the
   keyring again. It must be the bytes it wrote, or a keyring that already
   descends from them. Otherwise the provider let another write replace it
   (it ignored the compare-and-swap): the re-key reports *not confirmed*
   ("the revocation may not have taken effect"), and the device keeps its own
   keyring as its anchor, so its next round sees the replacement as a fork.
   Every same-epoch rewrite (`rev + 1`) is read back the same way, and fails
   if it was replaced.
4. **Header** (a passphrase change only): write the new header, then
   rewrite the keyring without `header` and `prev` (`rev + 1`). Until the
   header lands, the new passphrase opens the header the keyring carries,
   and the old passphrase opens epoch N from `prev`, never N+1. Any device
   at N+1 finishes this step.

If the manifest a keyring names is missing or doesn't open, a device
re-creates it from the frozen manifest `carry` names (exactly that digest),
unless that would be behind its own anchor. No blob is ever rewritten.

**Calling a freeze off.** A device whose rounds have seen frozen manifests
at its epoch, one after another, for 10 minutes on its own clock (`at` from
another clock is never used; a fresh freeze doesn't restart the wait, G1,
and an unfrozen manifest or a new epoch ends the run) calls the re-key off: at epoch N ≥ 1 it rewrites the keyring (`rev + 1`)
adding the frozen digest to `aborted`, so the re-keyer's commit, a
compare-and-swap on the keyring, fails; then it writes over the freeze. At
epoch 0 there is no keyring to rewrite: it finishes the re-key itself
(steps 2 and 3, create-only, for the passphrase alone). Blobs replaced by a
commit over a freeze are deleted only by a later round.

**A re-key replaced by a sibling** (N2, F2). When a device's round finds a
fork, and the live keyring descends from the keyring its last confirmed
re-key replaced (the same `[N, rev, parent]` in its chain) at that re-key's
epoch **or any later one**, opening with the same epoch-N secret in `older`,
and it doesn't revoke every device this device revoked (or lets one in again
by id or key), the device revokes them again on top of it (a re-key from the
live keyring), then stops the round with a fork error that names them:
anything written in between may be readable by them. A fork it can't repair
names the devices it revoked in the last 30 days: their revocation may be
undone.

**Revocations are sticky** (F2). A device keeps the devices it revoked, with
their keys, in its own state, authenticated with
`HMAC(HKDF(S_0, vaultId, "lumen-e2ee/1/revoked-here"), JSON ["lumen-e2ee-revoked-here/1", vaultId, deviceId, devices])`.
Every re-key it makes leaves them out, by id and by key, and every round
checks the keyring against them: a keyring that lists one again — which no
honest client writes, since a revoked id or key can't be enrolled again — is
revoked again on top, or the round stops with the revocation at risk.
The sealed `revoked` list only grows (seventh review 12.11, G5): a device
also keeps every device the sealed list of a keyring it adopted named
(`sealedRevoked`), and a later keyring that leaves one of them off the list,
or lets one in again by id or key, is treated the same way. This needs no
local list, so it survives a restored backup or a reinstall that pairs
again. A local list whose MAC doesn't verify is set aside, not a reason to
stop every round: the round reports it (`revokedListReset`, "check the
device list on a device you trust"), and the sealed lists still apply.

**Who may change keys.** Enrolling needs a device whose state is verified
(it created the vault, was paired, or the user confirmed it, §6), and both
need a provider that proved its conditional writes (§1). A device that is
not verified can re-key, but it can't vouch for the sealed device list (the
provider may be showing it an old one), so its re-key wraps the new epoch
for the passphrase and the devices it enrolls in that re-key only; every
other device pairs again (`dropped`). Served an old epoch, it never wraps
for a device revoked meanwhile. Leaving devices out takes the user's
consent (fifth review 12.11, F3): without `dropDevices`, such a re-key is
refused with the list of devices it would leave out. A device makes no key
change while a pairing code or answer it made is still valid (§6), unless
the user cancels the pairing, and makes no pairing code while one of its own
key changes is running (seventh review 12.11, G3): the code would vouch for
the epoch being replaced. The pairing lock is checked again right before the
keyring commit.

**The next passphrase's KDF** (F5). A passphrase change keeps the KDF family
of the stored header only if that header's MAC verifies under the device's
header key; a header that doesn't verify counts as Argon2id. An Argon2id
vault never moves to PBKDF2.

**Revocation**: a device without a wrap at epoch N+1 can't learn `S_{N+1}`,
so it can't open a manifest written after its revocation. A revoked id or
key is never wrapped for again, and can't be enrolled again. If its user
knows the passphrase, the passphrase changes in the same re-key.

## 6. Pairing codes

Every pairing message is `prefix + N + ":" + b64u(tag ‖ body)`, where `N` is
the sender's epoch, `pairing_N` that epoch's pairing key (§3, from `S_N`;
the master at epoch 0), and

`tag = HMAC(pairing_N, "lumen-pair/" + kind + "/" + version + "\0" ‖ body)`

(fifth review 12.11, F1). The MAC covers the message's kind, the body says
its kind (`"kind"`), and each kind has exactly its own fields — a reader
refuses any other — so a request can't be passed off as an answer or a
one-way code, nor the reverse:

| kind | prefix | version | body fields |
|---|---|---|---|
| `request` | `lumen-pair-request:2:` | 2 | `kind, vaultId, epoch, ringRev, ringDigest, counter, digest, requestedAt, nonce` |
| `answer` | `lumen-pair-answer:2:` | 2 | `kind, vaultId, request, nonce, counter, digest, epoch, ringRev, ringDigest, answeredAt` |
| `code` | `lumen-pair:3:` | 3 | `kind, vaultId, counter, digest, epoch, ringRev, ringDigest, issuedAt, nonce` |

Messages of earlier builds (`lumen-pair:2:`, `lumen-pair-request:1:`,
`lumen-pair-answer:1:`) are refused as "from an older build".

**Two-way pairing** (third review 12.11, N3), the default:

1. The new device shows a request: the keyring and manifest it sees
   (`counter`, `digest` `null` before its first round) and 16 random bytes
   (`nonce`).
2. An existing, verified device reads its keyring and manifest **now**, then
   checks the request against them. A request from an older epoch (it opens
   it with `older["N"]`'s pairing key) or an older revision is refused: the
   provider is showing the new device old keys, whichever device made the
   newer ones. Same epoch and revision with another digest is a fork. A
   newer request means this device must sync first. Otherwise it answers with
   its anchors at that moment, the request's nonce, and `request =
   sha256hex(the request's text, trimmed)`. It then makes no key change for 5
   minutes, unless its user cancels the pairing (then tell the new device not
   to use the answer).
3. The new device accepts only the answer to its own outstanding request —
   the same `request` hash and nonce — at the epoch it sees, within 5 minutes
   of making the request, on its own clock (no other device's clock is
   compared).

**One-way codes** carry the issuing device's verified anchors — the manifest
`(counter, digest)` and the keyring `(epoch, rev, digest)`, `ringDigest` `""`
at epoch 0 — and no key material. A device that sees an older epoch than `N` says so
(its provider may be replaying keys) instead of trying the HMAC. A one-way
code vouches for the issuer's state when it was made, so it is valid for 2
minutes (15 before the third review), and the issuer makes no key change
while it is valid.

Why two-way: refusing key changes while a code is valid only covers changes
made on the issuing device. The two-way answer is made after the new device
has looked at the vault, from the answering device's state at that moment,
so a new device shown an epoch from before *any* device's revocation is
caught on the answering device. What remains is a key change made on a
third device between an answer and its use (§9).

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
- `pairing[]`: one-way codes for vault 1 (epoch 0) and vault 2 (epoch 2,
  keyring revision 1), with what they anchor.
- `pairingTwoWay[]`: a request and its answer for the same two vaults, with
  what each says; the request relabelled as an answer or a code must not
  verify.

```sh
python3 scripts/sync-protocol/check_vectors.py      # the independent reader: 31/31
npx vitest run src/__tests__/e2eeVectors.test.ts    # Lumen's own reader, same file
```

## 9. Threat model in one paragraph

The provider is untrusted. It sees object names of a fixed length, padded
sizes, timing and the header's KDF parameters. It can withhold, replay or
delete objects. Withholding and deleting are denial of service. A replay is
detected by a device that has an anchor — it created the vault, was paired,
or saw the vault before — through the manifest counter and history and the
keyring chain (§5); pairing codes carry both anchors. Anchors are bound to
the epoch's secret (§5 *Anchors*), so a provider that makes a whole keyring
for a device's public key (a device opened with its own age key) can't move
that device into a vault of its own. It can't read, forge or reorder the
content of a device that has an anchor.

**Inherent limits:**

- *No anchor.* A device opened with the passphrase alone and never paired
  can be shown an old state, an old epoch included (with the old
  passphrase, the epoch before a passphrase change, through an old keyring
  that still carries `prev`). Such a device says "freshness not verified",
  **doesn't upload** (its changes wait on it until it is paired or
  confirmed), can't enroll devices, and a re-key from it wraps for no other
  device; so nothing it does reaches a device revoked meanwhile.
- *Withholding a key change* (a split view). A provider can keep showing
  some devices the vault from before a revocation while the re-keyer sees
  its own. Every view is self-consistent, so no device errors; what the
  others write stays readable by the revoked device. Only a channel outside
  the provider shows it: a two-way pairing between the views is refused
  (§6). A revocation is therefore only as current as the other devices'
  view of it — confirm it by pairing them.
- *A provider that withholds or reorders every object after the probe.* A
  provider that drops If-Match on the keyring alone is stopped by the
  freeze: the second re-keyer sees the first one's frozen manifest and waits
  (§5, *Re-key* step 1). A provider that also lies about the manifest — shows
  the second re-keyer the manifest from before the freeze — can let both
  commit. The re-keyer's read-back (§5) catches a replacement that lands
  before it, and its next round catches one that lands after, at any later
  epoch, and revokes again on top of it; its own revocations are sticky.
  Neither can stop the other device's keyring from wrapping the new epoch for
  a device revoked in the replaced one, in the moment between that write and
  the re-keyer's next round: the other device acted on the keyring it
  verified, and only the provider knew both (fork consistency: with no
  channel between the devices, detection on merge is the best a client can
  do). Preventing it needs a server that keeps the compare-and-swap, or a
  channel between the devices; see §5 *A re-key replaced by a sibling*.
- *Pairing windows.* A one-way code vouches for its issuer's state for 2
  minutes, and a two-way answer for the answering device's state until the
  new device enters it (at most 5 minutes after its request); a key change
  made on a third device inside that window, plus a provider showing the new
  device the state before it, passes. The issuing or answering device itself
  makes no key change in that window, unless its user cancels the pairing.
- *Google Drive* can't make create-only atomic, so it is sync-only: no
  re-key, revocation or enrollment through it.

A device holding the current keys is trusted for that epoch; revocation
ends that at the next epoch. Not covered: a device that is compromised
*while* it is enrolled (it can read what it can sync), metadata (sizes,
timing, how many objects), and the provider's own access controls.

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
- Third review 12.11: anchors carry a check under a key from the epoch's
  secret, verified at every open and round (N1). Every keyring write is read
  back; a re-key replaced by a sibling is reported and revoked again (N2).
  The CAS probe uses random names and blob-sized contents, and races two
  creates; Google Drive is sync-only (N7). Two-way pairing; one-way codes
  last 2 minutes and block their issuer's key changes (N3). Unverified
  devices don't upload, and their re-keys wrap for no device (N6, RR-5). A
  wrap that doesn't open the keyring is reported as tampered, not as a
  revocation, and every rewrite makes all wraps again (N5).
- Fifth review 12.11: pairing messages are domain-separated — the kind is in
  the MAC and the body, each kind has its own fields, and the answer names the
  request's hash; versions request 2, answer 2, code 3 (F1). A re-key waits
  out another device's fresh freeze on its own clock (Q2). A device revokes
  again on top of any descendant of the keyring it replaced, and keeps its own
  revocations (F2). A device whose anchor check verifies isn't demoted after
  100 manifests or 64 keyring revisions; leaving devices out takes consent,
  and the devices left out are marked `dropped` (F3, F4). The next
  passphrase's KDF comes from the authenticated header, never down from
  Argon2id (F5). Pairing and device unlock check the anchor first (F6, F7).
  A pairing can be cancelled.
- Seventh review 12.11: the freeze wait is bounded per key change, so the
  device being revoked can't block its revocation by re-freezing (G1); a
  dropped marker counts only for the first epoch the device lacks (G2); no
  pairing code during this device's key change, and the lock is checked
  again before the commit (G3); the sealed revoked list only grows, and a
  local list that fails to verify is set aside with a message (G5). Inherent
  (G4): a code or answer already given out, entered after `cancelPairing` on
  a device the provider keeps on the old view, still pairs it; only telling
  that device not to use it helps.
