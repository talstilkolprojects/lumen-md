---
title: How Lumen stores your secrets
description: API keys and tokens are encrypted at rest; in the macOS and Windows desktop apps they go to the OS keychain.
---

Lumen keeps the secrets it needs on your device: AI provider keys, cloud
tokens (Dropbox, Google Drive, GitHub), the collaboration room password
and the research search key. None of them is sent anywhere except to the
service it belongs to.

## In the browser

Each secret is encrypted with **AES-GCM-256** under a key that WebCrypto
generates as **non-extractable** and keeps in IndexedDB. The raw key bytes
never exist in JavaScript, so a copied browser profile or a storage export
does not reveal your secrets.

What this does **not** protect against: code running inside Lumen's own
origin can still ask WebCrypto to decrypt. That risk is handled by the
Content-Security-Policy and the HTML sanitizer, not by the store.

If the browser has no IndexedDB or WebCrypto (very old engines), Lumen
falls back to plain local storage. The app does not show a warning for
this yet.

## In the desktop app

On macOS and Windows the secrets go to the **OS keychain** (Keychain /
Credential Manager). Lumen keeps only their names, so it knows what to
load.

## Not available yet

There is no master password, lock command or recovery phrase in the app
today. The code for a password vault with a 12-word recovery phrase exists
(`src/storage/vault.ts`) but is not connected to any screen. This page will
describe it when it ships.

## Per-document encryption

Encrypting a single note is a separate feature: `⌘K → Encrypt document`
(AES-GCM-256 with a per-document password, stored as a fenced block at
the top of the file). See [End-to-end encryption](/collab/encryption/).
