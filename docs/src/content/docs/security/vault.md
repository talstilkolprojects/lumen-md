---
title: Secrets and encryption
description: How Lumen stores API keys and tokens, and how to encrypt a document.
---

Lumen keeps the secrets it needs — AI provider keys, Git and cloud tokens,
the collaboration room password, the research search key — out of plain
browser storage. There is **no password-protected vault and no recovery
phrase**; an earlier draft of these docs described one that was never shipped.

## Where secrets live

| Where Lumen runs | How secrets are stored |
|---|---|
| Browser / installed web app | Each secret is encrypted with AES-GCM-256 under a WebCrypto key that is **non-extractable**: no script can read out the raw key bytes. The secrets no longer sit in localStorage as plain text, so a glance in DevTools, a localStorage dump or a synced settings export shows only ciphertext. |
| Desktop app on macOS / Windows | The operating system's keychain (Keychain / Credential Manager). Lumen keeps only the secret names, so it knows what to load. |
| Old engines without IndexedDB or WebCrypto | Plain localStorage, as before. Lumen reports this mode instead of hiding it. |

**Honest limits:**

- The key is stored in the same IndexedDB database as the encrypted
  secrets, and Lumen decrypts them at startup without asking for a
  password. Someone who copies the whole browser profile and opens it in
  Lumen can therefore use the stored key and read the secrets.
  Non-extractable stops the key from being *exported*, not from being
  *used*. Protecting against a copied profile needs a password you type
  (planned with whole-vault encryption, task 11.4) or the desktop app's
  OS keychain.
- Code running inside Lumen's own origin could also ask WebCrypto to
  decrypt. The Content Security Policy and the HTML sanitizer are what
  keep foreign code out.

Plain-text secrets left by older versions are encrypted and moved at startup.

## Encrypting a document

`⌘K → 🔒 Encrypt Document` encrypts the open note with AES-256-GCM under a
password you type. The note is replaced by an encrypted block; `Decrypt
Document` restores it. Lumen does not keep the password — lose it and the
note cannot be recovered.

## What is not encrypted

Your notes themselves are plain Markdown files (in the browser's private
file system, or a folder on desktop). Encrypting the whole vault at rest is
planned as an option (plan task 11.4).
