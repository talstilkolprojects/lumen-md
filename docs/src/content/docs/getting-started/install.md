---
title: Install Lumen
description: Lumen in the browser, as an installed web app, on the desktop (macOS, Windows, Linux) and on iOS / Android — and what each one stores where.
---

Lumen is the same app on every platform. The only differences are where
your notes are kept and how the app is updated.

| Platform | How | Notes are kept in |
|---|---|---|
| Browser | open the hosted app, or `npm run dev` from a clone | the browser's private file system (OPFS) |
| Installed web app (PWA) | the browser's **Install** button on the hosted app | the same OPFS; works offline |
| macOS / Windows / Linux | build with `npm run tauri:build` (Tauri 2) | a real folder on disk |
| iOS | `npm run ios:open` (Capacitor, opens Xcode) | the app's storage |
| Android | `npm run android:open` (Capacitor, opens Android Studio) | the app's storage |

## In the browser

Nothing to install. Notes stay in this browser's private storage and never
leave the device unless you turn on sync. **Clearing the site's data
deletes them**, so export the vault (*Export the whole vault…*, see
[Export and import](/workspace/export-import/)) before you clear
browser data, or keep the vault in a real folder.

The minimum versions (set by Tailwind CSS 4) are Safari and iOS 16.4+,
Chrome / Edge 111+ and Firefox 128+.

## Installed web app (offline)

Use the browser's install button (Chrome, Edge) or *Share → Add to Home
Screen* (Safari). The installed app opens without a network: the editor,
highlighting, fonts and your files are all cached.

## Desktop

There are no signed release builds yet, so build from a clone:

```bash
npm ci
npm run tauri:build
```

The desktop app keeps the vault as a folder of plain `.md` files that
other tools (git, Obsidian, a text editor) can open, and keeps secrets in
the OS keychain on macOS and Windows (see
[How Lumen stores your secrets](/security/vault/)). On Linux it needs
WebKitGTK 2.40+.

## iOS and Android

The mobile projects are generated with Capacitor:

```bash
npm ci
npm run ios:open        # or: npm run android:open
```

Then build and run from Xcode or Android Studio.

## Running from source

```bash
git clone https://github.com/talstilkol/lumen-md
cd lumen-md
npm ci
npm run dev
```
