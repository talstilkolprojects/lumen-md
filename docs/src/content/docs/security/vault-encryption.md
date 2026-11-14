---
title: Vault encryption at rest
description: Encrypt the whole vault where it is stored — OPFS, a real folder or the desktop folder — with a passphrase, a recovery key and auto-lock.
---

Optional. **Command palette → Vault encryption…** encrypts every note and
file of the vault where it is stored, so a copied browser profile, a lost
laptop or a synced folder shows only ciphertext. Lumen asks for the
passphrase when it opens the vault.

> **Read this before you turn it on.** An encrypted vault can't be read as
> plain text by Obsidian, git, a text editor or any other program — only by
> Lumen with the passphrase or the recovery key. If you use the same folder
> with other tools, keep the vault unencrypted (or keep a plain export).

## What is encrypted

| Where | How |
|---|---|
| Every file of the vault — notes, attachments, canvases, `.trash/`, `.git/` | AES-256-GCM, one random nonce per write, on every storage: the browser's own storage (OPFS), a real folder you picked in the browser, the desktop app's folder |
| History snapshots (the backups the Version History panel shows) | AES-256-GCM in IndexedDB |
| Agent traces (the last 50 runs, which include parts of notes) | AES-256-GCM in IndexedDB; migrated when encryption is turned on, deleted when it is turned off |
| Semantic search index (embeddings and the text of each chunk) | AES-256-GCM in IndexedDB |
| AI answer cache | Not written while the vault is encrypted; emptied when encryption is turned on or off |
| The open note and the open tabs, which Lumen normally keeps in `localStorage` to resume a session | Not kept; after a reload you open the notes again from the vault |

The fast search index lives in memory only and is never stored.

**Not encrypted:** file and folder names, file sizes and dates (the vault
stays a normal folder of files); the list of recent files; API keys and
tokens (they have their own store, see [Secrets and encryption](/security/vault/));
the encrypted sync's own state; version history of live collaboration rooms;
results of batch AI jobs; what the learning critic remembers. A vault export
(zip or folder) is plain text on purpose.

## Passphrase, recovery key, lock

- **Passphrase** — at least 12 characters. The key is derived with
  PBKDF2-SHA256, 600,000 iterations (the same function as the
  [encrypted sync](/sync/e2ee/)). Argon2id is reserved in the format and
  replaces it once its library is added; a vault that asks for Argon2id is
  refused by an older Lumen, never misread.
- **Recovery key** — 30 characters (150 random bits), shown **once**, when
  you turn encryption on, before anything is encrypted. Lumen goes on only
  after you confirm you saved it. The vault's key is derived from it, so it
  opens the vault even if you forget the passphrase *and* even if the
  vault's encryption header files were lost. Case, spaces and dashes don't
  matter when you type it back.
- **Lock** — after 15 minutes without a key press or a click (choose 5, 15,
  30, 60 minutes or never in the dialog), or **Lock now**. A locked vault
  covers the app with the unlock screen; nothing is read or written until it
  is unlocked, and saves made meanwhile go on afterwards.
- **Change passphrase** re-wraps the key; no file is re-encrypted.

## Safety: what happens if something goes wrong

- **Wrong passphrase** — refused; nothing is read or written.
- **Turning it on or off is cut off** (tab closed, battery, crash) — each
  file is converted copy-first: the new version is written next to it,
  read back and checked, and only then replaces the file. Every file is
  always either complete plain text or complete ciphertext, and Lumen reads
  both. **Check and repair** finishes the job.
- **A file changed by another program meanwhile** is left alone and done by
  the next run. A file that doesn't decrypt with this vault's key is
  reported and never overwritten or deleted.
- **The header** (`.lumen-encryption.json`, plus `.lumen-encryption.backup.json`)
  is written twice; one damaged copy is fine. It is removed only when no
  encrypted file is left. If both are gone, the recovery key brings the
  vault back.
- **A plain file dropped into the folder** reads normally and is encrypted
  by Check and repair.
- An encrypted vault can't be **moved** to another place (the move would
  copy decrypted notes): turn encryption off, move, turn it on again.

## Turning it off

**Vault encryption… → Turn off encryption** asks for the passphrase again,
then decrypts every file back to plain text. History comes back in the clear;
agent traces and the semantic index are deleted (they are rebuilt).
