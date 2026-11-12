---
title: The public server
description: A free live-share server for everyone that stores only encrypted rooms, deletes idle rooms after 90 days and keeps no IP addresses in its logs.
---

Live sharing works without any server: browsers connect to each other
directly over [WebRTC](/collab/webrtc/). A server adds two things. People on
different networks find each other (signaling), and a room stays available
when nobody else is online ([persistent rooms](/collab/persistent/)).

Lumen's public server does both, free, and **never sees what you write**.

## What the server can and can't see

| | The server |
|---|---|
| The text of your note | **Never.** It accepts only rooms with a password ([end-to-end encryption](/collab/encryption/)). Every change is checked before it is applied. A change that is not an encrypted envelope closes the connection, and nothing of it is stored. |
| The room's encrypted document | Stored, so a room survives everyone leaving. It is ciphertext. Without the room password nobody can read it, the server included. |
| Who may join a room | Only someone with the room password. The app proves it holds the password with a value derived from it, which is not the encryption key. The server keeps only a hash of that value, and the room accepts only the first one it stores. Knowing a room's name is not enough to join it, write to it or keep it. A new room also costs the app a few seconds of work, so filling the server with rooms is slow. |
| Rooms nobody uses | Deleted **90 days** after the last change. Only a change counts, and only someone with the room password can make one: connecting, or only reading, stores nothing. |
| Your IP address | Not in any log. The server code logs nothing about connections, and request logging is off. Cloudflare, which hosts the server, sees addresses as any network provider does. |
| Cursors and display names | Passed between the people in the room while they are connected. Never stored. The name is a random one ("Saffron", "Willow"), not yours. |
| Room names, times and sizes | Visible to the server. Room names are random. |

## If the server is down

The app keeps working. Rooms connect peer to peer over WebRTC, and your
notes are on your device. The server's health is at `/healthz` for uptime
monitors.

## Where it runs and why

On **Cloudflare Workers with Durable Objects**, on the free plan: one small
object per room, created near the first person who opens it (Cloudflare has
a data center in Tel Aviv). We compared three free options:

- **Cloudflare Workers + Durable Objects** (chosen): free plan includes
  WebSockets with hibernation, SQLite storage (5 GB) and 100,000 requests a
  day; 100 WebSocket messages count as 5 requests.
- **Fly.io**: no longer has a free allowance for new accounts.
- **Deno Deploy**: WebSockets work, but there is no single place that holds
  a room, so peers on different instances would not see each other.

## Running it

The server is `edge-workers/collab/` (it uses the same room code as the
Node server in `sync-server/`). Whoever owns the Cloudflare account deploys
it with one command:

```sh
npm run collab:deploy
```

It deploys the Worker, sets the token secret, checks `/healthz` and prints
the two build variables for the app: `VITE_YJS_WEBSOCKET_URL` and
`VITE_WEBRTC_SIGNALING_URL`. Measure the delay from where you are with
`node scripts/collab-latency.mjs wss://<server>/`.

To run your own Node server with the same rules, start
`sync-server/collab-server.mjs` with `COLLAB_E2EE_ONLY=1`. Rooms unchanged
for `COLLAB_RETENTION_DAYS` days (90 by default) are deleted.
