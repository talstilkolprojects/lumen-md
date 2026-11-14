---
title: Sync status, selective sync and time left
description: See what the encrypted sync is doing for every file, choose what each device syncs, and how long a round will take.
---

The encrypted sync (see [Encrypted sync](/sync/e2ee/)) shows its work.
Open **Sync** from the command palette (⌘K → *Encrypted sync…*) while the
vault is unlocked.

## A state for every file and folder

While the vault is unlocked, the file tree shows a small mark after each
name:

| Mark | State | Meaning |
|---|---|---|
| ✓ | Synced | This device and the vault have the same version. |
| ↻ | Waiting to sync | A change waits to go up or come down in the next round. An edit shows here as soon as you save it. |
| ! | Conflict | The note was changed here and on another device, and you have not chosen what to keep yet. |
| × | Can't sync | The path can't be synced as it is, for example a file here and a folder with the same name on another device. |
| – | Not synced on this device | Left out by this device's rules (below). |

A folder shows the most urgent state inside it: error, then conflict, then
waiting. Screen readers read each mark's name.

## Activity

The **Activity** section of the Sync panel lists what the sync did: every
file sent and received, with its size, deletions, notes kept on this device
and why, and the start and end of every round. A conflict is listed **the
moment the round finds it**, while the conflict dialog is still open.
**Needs attention** lists the files in conflict, with an error, or waiting.

The list is kept on this device only and is never uploaded.

## Time left

While a round runs, the panel shows a progress bar, how many files and
bytes are done, and an estimate of the time left ("about 3 min left"). The
estimate weighs files and bytes equally: a round of many small notes is
bound by requests, one of a few videos by bandwidth. Before anything has
finished it uses the speed of this device's earlier rounds; on the very
first round it says "estimating time left…" until it can measure.

## Selective sync: what this device syncs

Under **What syncs on this device** you can leave out:

- **folders** (one per line, e.g. `Videos` or `Archive/2019`), with everything inside;
- **file types** (e.g. `mp4, mov`);
- **attachments over a size** in MB. Notes (`.md`, `.txt`, …) are never left out for their size.

The rules are **per device** and saved **on this device only**. A phone can
skip `Videos/` while the laptop syncs everything. The form is shown before
you unlock too, so you can set the rules before a device's first round.

A file that is left out is invisible to the sync in both directions:

- it is **never read for upload and never leaves the device**, not even
  encrypted, and the vault's manifest does not name it;
- a newer version from another device is **not downloaded**, and a
  deletion made elsewhere is **not applied** here.

If the saved rules can't be read (damaged browser storage), the sync stops
with a message instead of syncing everything. Save the rules again to
continue.

## In the background (iOS, Android, browsers)

Lumen syncs when it goes to the background and when it comes back, and
every 5 minutes while it is open. iOS and Android pause apps in the
background, and a browser tab that is not visible may be paused too, so
sync does not run while Lumen is closed. The vault's keys exist only in
memory, and keeping them on the device so that a system task could sync
would weaken the encryption. When you come back after more than two
minutes and no round ran in between, the panel says so ("Sync did not run
while Lumen was in the background…") and a round starts at once.

## Benchmark

`npm run bench:sync` syncs 10,000 notes and 1 GB of attachments through a
local WebDAV server: device A's first sync up, device B's first sync down,
then one changed note each way. Plan limits: under 10 minutes for a first
sync, under 3 seconds for a single change.
