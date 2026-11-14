---
title: Desktop app updates
description: How the Lumen desktop app checks for, verifies and installs updates, and what it sends.
---

The desktop app (Windows, macOS, Linux) updates itself from the project's
GitHub releases.

- **Check:** command palette → **Check for updates…**. Lumen never checks
  on its own.
- **What is sent:** one request to the release server with the app version
  and platform. No notes, no account, no identifier. It appears in the
  privacy log.
- **Local only:** when the privacy policy is *local only*, nothing is
  checked. The command says so instead.
- **Verification:** every update is signed. The app checks the signature
  against the key built into it and refuses a file that doesn't match, or an
  older version presented as new.
- **Install:** after you confirm, Lumen downloads, verifies, installs and restarts.

A build without the update key (local and development builds) has no
updater. *Check for updates…* says it isn't configured, and new versions are
installed by hand.

## Signed installers

Release installers are code-signed once the project's signing certificates
are in place (Windows Authenticode, Apple Developer ID). Until then Windows
SmartScreen and macOS Gatekeeper show a warning on first launch.

## What the app is allowed to do

The window has no general file-system permission. It reaches only the vault
folder you picked, through Lumen's own commands. No shell, no arbitrary
HTTP from the native side, and no source maps in the shipped files.
