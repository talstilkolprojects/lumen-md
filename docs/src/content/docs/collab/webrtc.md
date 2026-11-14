---
title: Real-time WebRTC collaboration
description: Multi-cursor editing over a peer-to-peer mesh — no server account, no central log of your doc.
---

Lumen ships a real-time collab mode powered by [Yjs](https://yjs.dev)
over WebRTC. Open a doc, share the room link, and every keystroke
syncs to every peer in <30 ms.

## Start a session

`⌘K → Start collaboration`. A toast confirms the room name + copies
the share link to your clipboard:

```
https://lumen.app/#room=lumen-bright-river-77
```

Anyone with the link enters the same Y.Doc. Their cursor + selection
appears in your editor, coloured by their auto-assigned chip.

## Awareness UI

Each peer publishes:

- **Display name** — random adjective+noun combo, e.g. "Marble".
- **Colour** — auto-picked HSL hue.
- **Cursor + selection** — re-published on every selection change.

The editor renders peer cursors with a small floating name tag above
the caret. A peer's selection highlights with a translucent version of
their colour. The list of active peers shows in the status bar.

## End-to-end encryption

Without a password, the room is **not** end-to-end encrypted. Peers sync
the plaintext Yjs document, so any signaling server that relays
messages, the persistent collab server and anyone with the room link can
read it.

Set `localStorage["lumen.collab.password"]` (or append `&password=…` to
the share link) to change that. The editor's document then stays
local, and only AES-GCM-256 ciphertext envelopes (key = PBKDF2 of the
password, salted with the room name) go to the mesh and to any
persistence server. Peers without the password receive only ciphertext
and see a "Can't decrypt this room" error.

The password also encrypts y-webrtc's signaling, so a peer without it
can't connect at all and relays never see presence (names, colours,
cursor positions) — only peers holding the password do. Metadata such
as the room name and the volume and timing of edits is still visible.
A wrong password therefore looks like an empty room: Lumen asks before
sharing your document into it rather than forking the room silently. See
[End-to-end encryption](/collab/encryption/) for the full threat model.

## Rooms evaporate when the last peer leaves

WebRTC is peer-to-peer — there's no server holding the doc. The doc
state lives in each peer's Y.Doc, replicated over the mesh. Once
everyone leaves, the state is only in the OPFS workspace of whoever
saved it. To get persistent rooms (the Notion / Google Docs feel),
enable [persistent collab](/collab/persistent/).

## Comments / annotations

Inline comments anchor to text ranges via Yjs `RelativePosition`, so a
comment on "neural networks" stays attached to those words even when
collaborators insert paragraphs above. Open the comments panel from
`⌘K → View comments panel`.

## Performance budget

- Room cap: 20 simultaneous peers (raise via the WebRTC provider's
  `maxConns`).
- Per-update overhead in password rooms: ≈ 40 bytes (IV + GCM tag +
  envelope framing) per edit batch; edits made in the same tick share
  one envelope.
- Initial join: full Y.Doc snapshot synced via the signaling channel
  (≈ 1 KB per 1k characters of doc).

For documents larger than ~50k characters or sessions with >20 peers,
move to [persistent collab](/collab/persistent/) which uses
the persistent collab server (Hocuspocus + SQLite, `sync-server/collab-server.mjs`).
