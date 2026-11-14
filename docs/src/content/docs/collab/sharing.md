---
title: Sharing, roles and comment threads
description: Share a note to view, comment or edit with a link that expires; revoke it; comment threads with mentions.
---

With a [persistent collab server](/collab/webrtc/), a note in a
collaboration session can be shared with a **link that gives one role and
expires**. The server holds everyone to their role, also in end-to-end
encrypted rooms.

## Share a note

1. Start a collaboration session (⌘K → *Start collaboration*).
2. ⌘K → **Share this note…**.
3. Choose the access and the expiry, optionally who it is for, and press
   **Create link**. The link is copied.

| Access | Can |
|---|---|
| **Can view** | read the note and its comments, see who is there |
| **Can comment** | also write, answer and resolve comments |
| **Can edit** | also change the note |

Links expire after 1 hour, 1 day, 1 week or 30 days. The link contains the
room's key (so the note can be decrypted) and the link's id (what the server
checks). Send it only to the person it is for.

## Revoke a link

⌘K → **Share this note…** lists the note's links with their state. Press
**Revoke**: the server stops letting that link in at once and drops anyone
still connected with it **within a few seconds** (the server checks every
second). Their copy of the room key opens nothing without the server.

## Shared with me

⌘K → **Shared with me** lists the links you opened on this device, with
their access and whether they are still active, expired or revoked.

## Comment threads

Select text and add a comment (⌘K → *Add comment*). A comment stays on
its words while others edit around it, in Hebrew too. Write `@name` to
mention someone (also after a Hebrew prefix, as in `ו-@דנה`), answer in
the thread, and resolve it when done.

The threads are kept in the room and, for the note's owner and editors, in
a file next to the note: `plan.md` → `plan.comments.json`. It travels with
the vault (git, sync, export). When the note is shared again, its threads
come back and are placed on their quoted text.

## How it is enforced

- The first time you share a note, your device **claims the room** with an
  owner secret kept in its encrypted secret store; the server keeps only its
  hash. After that, only the owner gets editor access without a link.
- A room with share links is synced **through the server only**, not over
  the peer-to-peer WebRTC mesh, which could not hold anyone to a role.
- Each room has two documents on the server: the note and its comments.
  "Can view" may write neither, "Can comment" only the comments, "Can edit"
  both. A change sent by someone without the right is dropped, along with
  their connection.
- In the app, a view or comment link opens the note read-only and hides
  the comment controls a viewer can't use.
- Collab cursors and name labels follow the line's direction, so they sit
  on the right side of the caret in Hebrew and Arabic text, and a name in
  one script never reorders text in another.

## For server operators

`sync-server/collab-server.mjs` stores rooms' owners and share links in
its SQLite database (no document content). `COLLAB_REVOKE_CHECK_MS`
(default 1000) sets how often live connections of revoked or expired links
are dropped.
