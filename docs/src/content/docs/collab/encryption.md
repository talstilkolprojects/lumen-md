---
title: End-to-end encryption for collab
description: Add a room password and no relay, signaling server or sync server can read your document.
---

Lumen's WebRTC mesh is unencrypted by default: peers sync the Yjs
document directly, so a signaling server that relays messages, a
persistent collab server (Hocuspocus), or anyone who joins with the room
link can read the content. Setting a **room password** switches the
room to an end-to-end encrypted transport. Document content is then
only ever readable by peers that know the password.

## Turn it on

```js
// Either:
localStorage.setItem("lumen.collab.password", "open-sesame-12345");

// Or append to the share link:
//   #room=lumen-bright-river-77&password=open-sesame-12345
```

Every peer in the room must use the same password. A peer with the
wrong password can still connect, but it only receives ciphertext it
can't decrypt. Nothing is applied to its document, and it sees a
"Can't decrypt this room" error.

> Putting the password in the URL hash keeps it out of HTTP requests
> (browsers never send the `#fragment`), but it still lands in browser
> history and anywhere you paste the link. For anything sensitive,
> share the room link and the password through different channels.

## How it works

Each peer keeps **two** Yjs documents:

| Document | Contents | Attached to the network? |
|---|---|---|
| Plaintext doc | Text, comments, everything the editor shows | **No.** It stays in the tab. |
| Transport doc | One append-only `Y.Array` of ciphertext envelopes | Yes (y-webrtc, and the persistent server if configured) |

1. **Key derivation:** PBKDF2-SHA-256, 200 000 iterations, salt
   `lumen.collab.v2|<room name>`. The same password in two different
   rooms gives two unrelated keys.
2. **Outbound:** each local edit to the plaintext doc produces a Yjs
   update. Edits made in the same tick are merged into one update,
   encrypted with AES-GCM-256 under a fresh random 12-byte IV, and
   appended to the transport array as `{ v: 2, iv, ct }`. The format
   version and the snapshot flag are bound into the GCM tag as
   additional authenticated data.
3. **Inbound:** each envelope that appears in the transport array (from
   a peer or from the persistence server) is decrypted and applied to
   the plaintext doc with origin `e2e-remote`. The outbound listener
   ignores that origin, so received edits are never encrypted again
   (no update loop). If decryption fails, the envelope is dropped and
   the user sees an error. Unauthenticated bytes are never applied.
4. **Late joiners:** a peer that joins later receives the whole
   transport array through the normal Yjs sync, decrypts every envelope
   and rebuilds the document. Yjs buffers updates that arrive before
   their dependencies, so envelopes can be decrypted in any order.
5. **Compaction:** when the array grows past 500 envelopes, the peer
   that just wrote one encrypts a full-state snapshot (`s: 1`) and
   deletes only the envelopes it has already applied. A peer that has
   ever failed to decrypt something never compacts, so it can't throw
   away history it couldn't read.

## Who can read what

| Party | Document text & comments | Room name | Envelope count, sizes, timing | Presence: names, colours, cursor anchors |
|---|---|---|---|---|
| Peer with the password | Yes | Yes | Yes | Yes |
| Peer without the password | **No** | Yes | Only through a persistence server it can reach | **No** — it can't complete the WebRTC handshake |
| Signaling server | **No** | Yes | Traffic shape only (its messages are encrypted with the password) | **No** |
| persistent collab server (Hocuspocus) | **No** (it stores only ciphertext) | Yes | Yes | **No** — Lumen publishes no presence to it |
| Network eavesdropper | No (WebRTC is DTLS-encrypted anyway) | Depends on the signaling transport | Traffic shape | No |

### Persistent rooms store only ciphertext

With [persistent collab](/collab/persistent/) the persistent server
syncs the **transport** doc. Its database holds the envelope array and
never a key, so a leaked server backup reveals no document content. A
peer that joins later still needs the password to read the history.

## Limits: what this does *not* protect

- **Awareness / presence reaches every peer that holds the password.**
  The room password is also given to y-webrtc, which encrypts all
  signaling and BroadcastChannel traffic with a key derived from it, and
  peer connections are DTLS-encrypted — so the signaling server and peers
  *without* the password never see display names, colours or cursors.
  Presence itself is not wrapped in Lumen's envelopes, though: every
  password holder sees it. Cursor positions are Yjs *relative positions*
  (item IDs: client id + clock, no document text). The persistent
  persistent server receives no presence from Lumen.
- **Metadata:** room name, number of peers, number and size of
  envelopes, and when they are written. Size and timing can hint at
  how much is being typed.
- **Integrity of the history as a whole.** Each envelope is
  authenticated, but a malicious relay or persistence server can
  *drop* or *withhold* envelopes, or delete them from the array. That
  makes peers diverge or lose edits, but it can never inject or alter
  content. Replayed envelopes are harmless because Yjs updates are
  idempotent.
- **Anyone with the password.** All peers who know it are trusted
  equally. A peer with the password can also delete envelopes from the
  shared array.
- **Weak passwords.** The key comes only from the password and the room
  name, both of which a server operator knows. An attacker holding the
  ciphertext can run an offline guessing attack, slowed by 200 000
  PBKDF2 iterations per guess. Use a long passphrase.
- **No forward secrecy, no key rotation inside a room.** A password
  that leaks later decrypts all stored history. To rotate, create a
  new room with a new password (see below).
- **Local storage.** Version-history snapshots and saved files on each
  peer are plaintext on that device. Use a Vault password
  (`⌘K → Encrypt document`) for at-rest encryption.

## Rotating

The key is tied to the room, so the clean way to rotate is to move to
a new room with a new password:

```js
localStorage.setItem("lumen.collab.password", "new-stronger-passphrase");
```

Then leave and start a fresh room, seeding it from your current
document. If you change the password while staying in the same room,
peers on the old password get "Can't decrypt" errors, and the old
history stays encrypted under the old key on any persistence server.

## Trade-offs

- A misplaced password locks everyone out. Treat it like any shared
  secret and share it through a side channel (Signal, 1Password, etc.).
- The PBKDF2 derivation runs once per password and room. That is about
  100 ms on modern devices, but noticeable on old phones.
- Each edit batch adds about 40 bytes of overhead (IV + GCM tag +
  envelope framing). Long sessions grow the array until compaction
  kicks in at 500 envelopes.
