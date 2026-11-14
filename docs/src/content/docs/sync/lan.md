---
title: Sync on the local network
description: Sync two devices directly over your own network, end-to-end encrypted, with no cloud and no internet.
---

Next to WebDAV, S3, Dropbox and Google Drive, the [encrypted sync](/sync/e2ee/)
can keep your vault on **your local network only**. One device keeps the
vault and the others pair with it directly. There's no server, no account
and no cloud, and it works with no internet connection at all.

## Set it up

1. On the device that keeps the vault (a desktop that's usually on): ⌘K →
   *Encrypted sync…* → **Local network** → *Keeps the vault* → *Connect*,
   then choose a passphrase.
2. Still there: **Pair a device**. Lumen shows a pairing code as a QR code
   and as text.
3. On the other device: ⌘K → *Encrypted sync…* → **Local network** → *Joins
   a device that keeps the vault*. Paste or scan the code, then press *Answer*.
4. Bring the answer code back to the first device, paste it there and
   press *Connect*.
5. On the joining device, unlock the vault with the same passphrase.

From then on each device syncs **on its own**, shortly after you edit and
shortly after the other device reports a change. An edit reaches the other
device in under two seconds.

> Keep Lumen open on the device that keeps the vault while the others sync.
> If the link drops (the device slept, the network changed), pair again.
> Nothing is lost: the next round catches up.

## What crosses the network

The same thing a cloud provider would store: the vault header, plus sealed
manifests and blobs under HMAC names. The devices pass them directly, over a
WebRTC data channel (DTLS). Notes are encrypted before they leave a device
(AES-256-GCM, keys from your passphrase), exactly as with the other providers.

| | |
|---|---|
| Signaling server | None. The two pairing codes carry each device's connection details |
| STUN / TURN | None (`iceServers: []`) |
| Addresses used | Only local-network ones: 10/8, 172.16/12, 192.168/16, 169.254/16, 127/8, IPv6 link-local and unique-local, `*.local` |
| Who may write | Only a device that proves it knows the passphrase |

Two checks keep the link on your network:

- Every connection candidate, in both codes, must be a host candidate on
  a local-network address; any other candidate is dropped. Once connected,
  the address of the other end is checked again, and a link to anything
  outside the local network is closed.
- The device that keeps the vault serves only the vault header until the
  other device proves it knows the passphrase (an HMAC challenge in both
  directions under the vault's pairing key). A device with another
  passphrase, or one that has only a pairing code, can't list, write or
  delete anything.

The pairing codes carry no key material. The passphrase is still needed.

## The privacy ledger

Each link shows up in the privacy ledger (⌘K → *Privacy ledger*) as
*On this device / LAN*. Its host is the other device's local-network address
(or "address hidden by the browser" when the browser keeps it to itself),
along with the bytes the link carried. No entry for the LAN sync can show an
address outside your network.

## Scanning the QR code

The web app can't open the camera: its permissions policy turns the camera
off. To bring a code across, scan the QR code with another device's camera
app, or copy and paste the text, for example through a note-to-self or
AirDrop. Native scanning belongs to the mobile apps and is not part of this
version.

## Finding the device without a code (desktop app)

In the desktop app, there's no code to bring across:

1. On the device that keeps the vault, choose **Pair a device**. While the
   dialog is open, the device is also visible on the network under a
   random name such as **Lumen-K7Q2**, and the dialog shows that name.
2. On the other desktop, choose **Find devices on this network**, then
   **Pair with Lumen-K7Q2**. The two swap their codes by themselves and
   connect as usual. You still unlock with the vault's passphrase.

How it works: the hosting device announces the service `_lumen-lan._tcp`
over multicast DNS (mDNS, the way printers and AirPlay are found), and
serves its pairing code on a local port. The joining device fetches it and
sends its answer back. Only local-network addresses are answered or
contacted. Nothing about you or the vault is announced: only the random
name and the port. The codes carry no key, as with the QR code. A device
that takes a code without the passphrase can't pass the vault's proof. A
pairing is used up by the first answer, and the device stops announcing
once it is paired or the dialog closes.

A browser or a phone can't use mDNS: a web page can't send UDP or listen on
a port. There you use the codes. On macOS the first search asks for the
**local network** permission.

## How it's checked

- `src/__tests__/lanSync.test.ts`: two devices, the real sync engine, the
  link with LAN latency. **1,000 rounds** of random edits and deletions on
  both sides, sometimes at the same moment, end with **0 lost** (and every
  concurrent write kept, in the note or its conflict copy). The link
  carries no note text, and there is **not one** `fetch`. A change reaches
  the other device in **under 2 s**, both ways. Wrong passphrases and wrong
  hosts are refused.
- `e2e/lan-sync.spec.ts`: two browsers pair with the codes, unlock and sync
  both ways on their own. They make no request except to the app's own
  server, and the ledger shows local-network addresses only.
- `cargo test --manifest-path src-tauri/lan-mdns/Cargo.toml`: two
  processes find each other over real multicast DNS and swap the codes
  through the rendezvous, in both directions. Hostile packets (compression
  loops, truncation) are refused. A second answer, a wrong token or an
  address off the local network is refused too.
- `src/__tests__/lanDiscovery.test.ts`: the app passes through only Lumen
  names on local addresses, announces a pairing until it is answered or
  given up, and cancels a half-made link when its answer can't be
  delivered.
