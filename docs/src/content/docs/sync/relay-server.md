---
title: The share servers on Cloudflare
description: Deploy the live-share server and the encrypted sync relay to Cloudflare Workers with one command, then check the delay, the limits and that no note text is kept.
---

Lumen has two small servers. Both hold only encrypted data.

- **The live-share server** (`edge-workers/collab/`) relays rooms for
  [live sharing](/collab/public-server/).
- **The encrypted sync relay** (`edge-workers/vault-relay/`) stores the
  encrypted files of [encrypted sync](/sync/e2ee/) for devices that have no
  sync folder and no WebDAV. It runs the same code as the Node relay in
  `sync-server/vault-relay.js`.

Both run on **Cloudflare Workers with Durable Objects**, on the free plan.

## Deploy both with one command

The owner of the Cloudflare account runs:

```sh
npm run share:deploy
```

It logs in to Cloudflare first if needed (`wrangler login` opens the
browser). Then it deploys `lumen-collab` and `lumen-vault-relay` and checks
each `/healthz`. At the end it prints the three build variables for the app:
`VITE_YJS_WEBSOCKET_URL`, `VITE_WEBRTC_SIGNALING_URL` and
`VITE_SYNC_RELAY_URL`.

- `npm run share:deploy -- --bundle-only` builds both Workers without
  deploying anything.
- `npm run share:deploy -- --dry-run` prints every command and runs none.

## The owner session: deploy and check

```sh
npm run owner:share
```

This runs the deploy above and then four checks. It stops with an error
if any check fails.

1. **Delay from where you are.** Two clients edit one room through the
   live-share server. A third client writes and reads back through the
   relay. The p95 must be under **150 ms**. Run it from Israel: the delay
   that counts is yours.
2. **The relay's limits on the real servers.** A temporary copy of the
   relay is deployed with tiny limits (64 KiB in all, two new spaces a day
   per address). The check confirms that a third space from your address
   gets 429 and that writing past 64 KiB gets 507. The copy is then
   deleted. Wrangler asks before deleting it; answer `y`.
3. **No note text in the logs.** While step 1 writes a known test note,
   `wrangler tail` records both servers. `share:scan` searches the records
   for that note as plain text, UTF-16, hex and base64. It must find 0
   matches.
4. **A receipt** goes to `~/.lumen-owner/share-receipt-<time>.json`.

Last, by hand: open one share link in two browsers on two networks, for
example a laptop on Wi-Fi and a phone on mobile data, and edit together.

For uptime, add both `/healthz` addresses to a free monitor such as
UptimeRobot and turn on its public status page.

## Limits of the relay on Workers

| Setting | On Workers | Why |
|---|---|---|
| `VAULT_RELAY_MAX_OBJECT` | 2 MiB | The free plan gives a request 10 ms of CPU. Storing an object reads it, hashes it and writes it: about 6 ms for 2 MiB and 12 ms for 4 MiB in our measurement. Run your own relay (`sync-server`, `VAULT_RELAY=1`) for files up to 25 MiB. |
| `VAULT_RELAY_MAX_TOTAL` | 768 MiB | The ceiling for all spaces together. The free plan has 5 GB of storage per account, and the live-share server may use up to 4 GB of it. |
| `VAULT_RELAY_NEW_SPACES_PER_DAY` | 5 | New spaces per address (an IPv4 address, or an IPv6 /64) per UTC day. |
| `VAULT_RELAY_ADDRESS_BYTES_PER_DAY` | 128 MiB | Bytes one address may write per UTC day. |
| `VAULT_RELAY_POW_BITS` | 18 | A new space costs the app a short proof of work. |

The daily counts are kept in the Durable Object's storage, so they still
hold after Cloudflare unloads an idle object. They are stored under a keyed
hash that changes every day, never as addresses. The previous day's counts
and key are deleted when a new day starts.

## Checking it on your own computer

```sh
node scripts/share-latency.mjs --collab wss://<collab>/ --relay https://<relay> --big
node scripts/share-scan.mjs --text "a line of your note" <a folder or a log file>
```

`share-scan` searches files and folders, SQLite databases included. It
exits with 1 and lists every match it finds.
