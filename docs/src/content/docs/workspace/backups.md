---
title: Backups to a second drive
description: A daily backup of the whole vault to another drive or folder, plain or encrypted with age, kept 7 days, 4 weeks and 6 months, and a restore you can check.
---

Version history protects you from your own edits, but it lives on the same
disk as the vault. **Backups** copy the whole vault somewhere else, once a
day while Lumen is open.

## Set it up

⌘K → *Backups…*, then choose one of:

- **Back up to a folder or drive…** writes a plain `.tar` archive that any
  archive tool opens.
- **Back up encrypted to a folder or drive…** writes `.tar.age`, encrypted
  with [age](https://age-encryption.org) to a backup key made for you. The
  panel shows the key (`AGE-SECRET-KEY-1…`) once. Keep it away from this
  device: without it nobody can open the backup, you included. Only its
  public half is stored.

A folder that is the vault, or inside it, is refused: backups there would
sync, and every backup would contain the ones before it. Git internals and
the trash aren't backed up.

## What's kept

The newest backup of each of the last **7 days**, **4 weeks** and **6
months**: at most 17 archives. Older ones are deleted after each backup.

## When something's wrong

- A backup that fails (an unplugged drive, a folder the browser no longer
  lets Lumen write to) is shown at once: a notice, and a red line in the
  panel. Lumen tries again after 15 minutes.
- **Three days** without a successful backup is shown once a day.

## Restore

- **Restore everything to a new folder…** puts the newest backup's files
  into a folder you pick.
- **Restore it into the vault** restores one file or folder. Nothing is
  overwritten: a file that's already there is restored next to it, as
  `name (restored 2026-11-10).md`.

Every archive starts with a list of its files and their SHA-256. A restore
checks each file and refuses a damaged archive.

Without Lumen:

```sh
tar -xf lumen-backup-2026-11-10T03-12-00Z.tar
age -d -i backup-key.txt lumen-backup-….tar.age | tar -x
```

## How it's checked

`src/__tests__/backup.test.ts` backs up 1,000 notes and 200 attachments,
deletes the vault and restores it, plain and encrypted: **every file has the
same SHA-256**. It also checks that a broken drive is reported within a
minute, and that a backup writes nothing into the vault.
`e2e/backup-drill.spec.ts` runs the same drill from the panel in the browser.

## Limits

- The browser needs the File System Access API to write to a folder
  (Chromium). The desktop app's own folder access (Tauri) and WebDAV targets
  are behind the same `BackupTarget` interface and come with their pull
  requests.
- Backups run while Lumen is open, so a laptop that's always closed gets
  none. The three-day notice says so.
