---
title: Persistent rooms
description: Keep a collaboration room alive when every peer has left, with a small y-websocket server you run yourself.
---

A plain [WebRTC room](/collab/webrtc/) lives only in the browsers that are
in it: when the last person leaves, the room is gone (whoever saved the
note keeps their copy). A **persistent server** keeps each room's
document, so anyone can join later and find the latest version, even when
nobody else is online.

## Run the server

`sync-server/persistent-server.js` is a small
[y-websocket](https://github.com/yjs/y-websocket) server that stores every
room on disk with LevelDB.

```bash
cd sync-server
npm install @y/websocket-server y-leveldb
PORT=4444 node persistent-server.js        # ws://localhost:4444
```

- **Storage:** `YJS_STORAGE_DIR` (default `./.yjs-persistence`). On Fly.io,
  Render or Railway, point it at a mounted volume. The Docker compose
  bundle uses `/data/yjs`.
- **Access token:** start it with `COLLAB_TOKEN=<a long random string>`
  and it accepts only clients that send the same token. Without one,
  anyone who knows a room name can read the room's (encrypted) updates
  and add their own.
- **Health:** `GET /healthz` answers `200 {"ok":true}`.
- Put it behind TLS (`wss://`) before you expose it.

`DEPLOY.md` has the Fly.io steps.

## Point Lumen at it

Set it when you build Lumen:

```bash
VITE_YJS_WEBSOCKET_URL=wss://collab.example.com
VITE_YJS_WEBSOCKET_TOKEN=<the same COLLAB_TOKEN>   # if the server has one
```

Lumen then connects to the server alongside the peer-to-peer mesh. Where
billing is configured, persistent rooms need a Pro or Team plan; a
self-hosted build without billing has them on.

## What the server can read

Nothing, in a room with a password. The server stores only the
AES-GCM-256 ciphertext envelopes, never the text. Rooms created today
have 128-bit random names and are end-to-end encrypted, so the token is
a second gate, not the only one. What the server does see: room names,
and the size and timing of updates. See
[End-to-end encryption](/collab/encryption/#persistent-rooms-store-only-ciphertext).
