---
title: Encrypted live sharing
description: Share a note live through a server that stores and relays only ciphertext, names and cursors included.
---

A note you share from Lumen goes through the collab server end-to-end
encrypted. The server keeps people to their [roles](/collab/sharing/) and
holds the room's history, but it can't read the note, its comments, or
who is in it and where their cursor is.

## What the server sees

| | Encrypted in the browser | What the server holds |
|---|---|---|
| The note | Yes (AES-GCM-256, a [ciphertext transport document](/collab/encryption/)) | Envelopes `{v, iv, ct}` |
| Comment threads | Yes, the same way (`<room>~comments`) | Envelopes |
| Presence: names, colours, cursors | Yes (since plan W2.20) | `{ "e2e": "<base64>" }` per participant |
| The room key | It never leaves the link | Nothing |
| Room name, share ids, roles, expiry | No (the server needs them) | Those, in SQLite |

The room key is in the link's fragment, after the `#`
(`#room=…&password=…&share=…`). Browsers never send the fragment to a
server, and Lumen never puts the key in a request: token requests carry
the room name, the share id or owner secret, and the operator's access key.

## Sealed rooms

An encrypted client asks for its token with `e2ee: true`, and the server
**seals** the room. From then on, for good:

- an update that writes anything except ciphertext envelopes (text, a map
  entry, a nested type, an array element that isn't an envelope) is
  refused and its connection dropped, before it reaches the room;
- a presence state with any field except `e2e` is refused the same way;
- a document that isn't ciphertext-only is never written to disk.

A room that already stores readable content (an old plaintext room) is not
sealed. To run a server that takes encrypted rooms only, set
`COLLAB_REQUIRE_E2EE=1`: every room is then sealed and plaintext clients
can't write at all.

The server checks the shape. It can't tell ciphertext from other bytes
inside `ct`; what keeps `ct` unreadable is the client, which only ever
writes AES-GCM output there.

## Encrypted presence

Each participant has two awareness instances. The editor's cursors and the
peer list use the plain one, which no provider touches. The providers sync
a transport awareness where each state is the plain state sealed under the
room key. Two values are bound into the seal:

- the participant's client id (in the GCM tag), so a relay can't show one
  participant's name or cursor as someone else's;
- a counter that only goes up, so a relay can't replay an older cursor.

A state that isn't sealed, or doesn't open with the room key, is never shown.

## Sharing needs an encrypted room

The share dialog makes links only for a room with its own key, which every
new collaboration session has. For a session joined from an old link
without a key, start a new session first.

## How it's checked

`src/__tests__/collabE2eeSharing.test.ts` runs the real server and records
every WebSocket frame both ways:

- the note's text (Hebrew and English), a comment, both participants'
  names, a cursor and the room key: **0 hits** in the traffic, the stored
  states and every file in the server's data directory. The same search on
  a room that isn't encrypted does find the text, so the check can fail;
- a plaintext writer, and plaintext presence, are refused in a sealed room;
- an edit reaches the other participant in under 150 ms (p95 over 40 edits);
- a 1 MB note with 5 participants and 1,000 random edits converges with 0
  edits lost, and a sixth participant gets the same note from the server.

## Limits

- The server still sees metadata: the room name, how many people are
  connected, when they edit and how much.
- Anyone with the link has the key. Revoking a link cuts its holder off
  from the server within seconds, but a copy of the note they already have
  stays theirs.
