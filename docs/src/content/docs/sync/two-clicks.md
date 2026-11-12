---
title: Sync in two clicks
description: A guided setup that picks the best place for your encrypted notes on this device, makes the key for you, and shows every file's state.
---

Run **Set up sync (two clicks)** from the command palette.

## 1. Where the encrypted copy lives

The best choice for this device is already selected:

| Place | When it is first | What you need |
|---|---|---|
| **A folder of iCloud Drive, Dropbox, Google Drive or OneDrive** | On a computer whose browser can open folders (Chrome, Edge) | The sync app you already have. Lumen writes only encrypted files, into a `Lumen sync` folder inside the one you pick. |
| **Lumen's encrypted relay** | On phones, and browsers that can't open folders | Nothing. The relay stores encrypted files and can't read them. |
| **WebDAV** (Nextcloud, a NAS) | When neither of the above is there | The server's address, user name and password. |

**Advanced** opens the full panel: S3, and Dropbox or Google Drive through
their own sign-in once those are available.

## 2. Your key: 13 Hebrew words

Lumen makes the key for you: 12 random words from a list of 256 everyday
Hebrew words (96 bits), and a 13th word that checks the others, so a typo
is caught at once. Write them down or keep them in a password manager, then
type back the word Lumen asks for. That shows you saved them.

**Before anything starts, the setup says it plainly:** without these words
nobody can open the encrypted copy, not even Lumen. Your notes on the device
stay either way.

## 3. Every file's state

After the first round the setup lists how many files are **synced**,
**waiting**, in **conflict**, or **can't sync**, and names each one that
needs you. The file tree shows the same state next to every note
([Sync status](/sync/status/)).

## The next device

Open Lumen, run **Set up sync**, choose the same place, tap **I already have
a key**, and paste the 13 words. Typing is forgiving: niqqud, punctuation,
extra spaces and final letters (ם or מ) don't matter.

## How the relay keeps no secrets

The relay sees a token that is a hash of your words, never the words, and
stores only a hash of that token. Every object it keeps was encrypted on
your device with keys it never sees (the [encrypted sync](/sync/e2ee/)
format). It deletes a space nobody has read or written for 180 days: a vault
you only read on your devices is kept.

Running your own relay: `VAULT_RELAY=1 node sync-server/server.js` (or
`node sync-server/vault-relay.js`), with `VAULT_RELAY_DIR` to keep the
objects on disk, and build the app with `VITE_SYNC_RELAY_URL` set to its
https address.

A token costs nothing to make, so the relay also limits what one address and
the whole server can hold:

| Setting | Default | What it limits |
|---|---|---|
| `VAULT_RELAY_MAX_SPACE` | 1 GiB | one vault's space |
| `VAULT_RELAY_MAX_TOTAL` | 20 GiB | all spaces together |
| `VAULT_RELAY_NEW_SPACES_PER_DAY` | 5 | new spaces one address may open a day |
| `VAULT_RELAY_ADDRESS_BYTES_PER_DAY` | the space size | bytes one address may write a day |

Addresses are never stored: the relay counts them under a keyed hash whose
key is random, kept in memory only and replaced every day.

An IPv6 address counts as its /64, since one host usually holds a whole /64.
The counts sit in a fixed-size table that never forgets an address, so other
addresses cannot reset them. A burst of requests sent at once is counted in
full. Every object is charged the disk space it takes, in whole 4 KiB blocks,
so many tiny objects cost what they really cost.

Behind a reverse proxy, every request comes from the proxy's address. Mounted
in `server.js`, the relay uses the client address that `server.js` reads
(`SIGNAL_TRUST_PROXY=1`, which `fly.toml` sets). The standalone relay reads
`Fly-Client-IP` when the request comes from a private network, as Fly's proxy
does, and the last `X-Forwarded-For` entry when it comes from the same machine
or a private network, as nginx adds it. A proxy other than Fly's must remove a
client's own `Fly-Client-IP` header. `VAULT_RELAY_TRUST_PROXY=0` turns both
headers off.

A public relay can also ask for more before it opens a new space (existing
spaces are not affected):

- `VAULT_RELAY_POW_BITS=18`: a proof of work. The app solves it by itself, in
  a few seconds, the first time it writes to a new space. The relay accepts
  at most 24 bits, the most the app will solve.
- `VAULT_RELAY_INVITE=<secret>`: an invite. Build the app with
  `VITE_SYNC_RELAY_INVITE` set to the same secret. Anyone who has the build has
  the invite, so use it for a relay whose app you don't publish.
