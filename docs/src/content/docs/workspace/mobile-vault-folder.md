---
title: The vault in a folder on your phone
description: In the iOS and Android apps, keep the vault in a real folder — the Files app on iOS, a folder you pick on Android — and see edits made there.
---

In the phone app the vault starts in the app's private storage. **Command
palette → Move the vault to a folder…** puts it in a real folder on the
phone, where other apps can open and edit the notes:

| | Where the vault goes |
|---|---|
| **iOS** | The app's Documents folder. In the **Files** app it is *On My iPhone › Lumen*; other apps can open and edit the notes in place. |
| **Android** | A folder you pick in the system's folder picker (any folder on the phone or the SD card). Lumen keeps the permission across restarts. If the app was built without Lumen's folder plugin, the app's own folder on the device is used instead. |

The move copies every note, reads each copy back and compares it, and only
then switches; the app storage is kept as it was. **Open a folder as the
vault…** uses a folder that already has notes, without copying.

## Edits made in other apps

Lumen checks the folder every few seconds while it is open, and at once
when you come back to it (for example from the Files app). A changed note
updates in Lumen; if you changed the same note in Lumen at the same time,
you get the conflict dialog and nothing is lost (see *Changes made outside
Lumen*).

## When the folder is gone

On Android the permission can be taken back in the system settings, or the
folder can be deleted. Lumen then shows the vault as **disconnected** and
reads and writes nothing until you pick the folder again (**Reconnect**).

## Status

The app side is complete and tested against both phone file APIs. The
native pieces are listed in `mobile/README.md` in the repository: the
official `@capacitor/filesystem` plugin (iOS and the Android fallback) and
Lumen's small Android folder plugin; checks on real devices are still open.
