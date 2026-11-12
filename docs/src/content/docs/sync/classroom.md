---
title: Private classroom
description: A teacher hands out a template, students hand in sealed work, and the teacher's comments come back. Only the teacher reads a student's work, and the server reads nothing.
---

Run **Private classroom…** from the command palette.

## Teacher

1. Open the note you want to hand out (the questions, a worksheet, a template).
2. In **Private classroom**, give the assignment a title and choose **New assignment from the open note**.
3. Copy the **link for the class** and send it however you like: the school's messaging app, email, the board.
4. Later, choose **Check submissions**. Each submission opens on this device only. Choose **Open in a tab** to read it, and write a comment under it. **Send comment (sealed)** seals it so that only that student can open it.
5. At the end of the assignment, **Delete from the relay** removes every submission and comment from the server.

The assignment's key lives only on the device where you made it. Check submissions on that device.

## Student

1. Open the link. Lumen offers to join: type your name (only the teacher sees it) and choose **Get my copy**. The template opens in a new tab. Nothing has been sent yet.
2. Work in the note as usual. Drafts stay on your device.
3. When you are ready, open **Private classroom** with your note open and choose **Hand in**. The note is sealed to the teacher and sent. If you hand in again, the teacher sees each version.
4. **Get comments** adds the teacher's comments to the end of the open note, as a callout.

## On the school network, without the cloud

The classroom uses the same encrypted relay as [sync in two clicks](/sync/two-clicks/). A school can run that relay on its own network:

```sh
VAULT_RELAY_DIR=/srv/lumen-relay PORT=4446 node sync-server/vault-relay.js
```

It can also run inside the live-share server (`VAULT_RELAY=1 node sync-server/server.js`). Then build Lumen for the school with `VITE_SYNC_RELAY_URL` pointing at that relay. The setting also allows the relay's address in the app's Content-Security-Policy. The school's Lumen and its relay can work with no internet at all. A link always names its relay. A copy of Lumen built for another relay refuses the link and says why.

The relay counts, per network address and per day, the new spaces it opens and the bytes it takes (5 spaces and 1 GiB by default; see [sync in two clicks](/sync/two-clicks/)). A whole school usually reaches the relay from one address, and each assignment is a new space. On a school relay, raise `VAULT_RELAY_NEW_SPACES_PER_DAY` and `VAULT_RELAY_ADDRESS_BYTES_PER_DAY` to fit the class.

## How it works

| What | Where it goes | Who can read it |
| --- | --- | --- |
| Template, title, the assignment's public key, relay address, drop box id | In the link's `#fragment`. Browsers never send the fragment to a server. | Anyone you give the link to |
| The assignment's private key and the owner token | Only the teacher's device (IndexedDB, as a non-extractable key) | Nobody else |
| A student's own key pair (one per assignment) | Only the student's device | Nobody else |
| A submission: name, work, the student's public key | The relay, as a sealed box | Only the teacher |
| A teacher's comment | The relay, as a sealed box, under a name only the teacher and that student can work out | Only that student, who can also check that the teacher wrote it |

- **Sealed boxes.** Each one uses a fresh ECDH P-256 key, HKDF-SHA-256 and AES-GCM-256, all from the browser's own WebCrypto. A submission is sealed to the assignment's public key. A comment is sealed to the student's key and bound to the teacher's key. Only a box made with the teacher's private key opens as a comment.
- **Append-only drop box.** The link gives an append-only right on the relay (`Bearer a.<id>`). A link holder can add a new object and read objects, but cannot replace or delete one. The relay refuses with 403. Only the owner token (`Bearer o.<token>`), which stays with the teacher, can delete. The relay keeps a hash that names the box. It never keeps the id or the token.
- **Padding.** Each box is padded to a size bucket: 1 KiB, then powers of two up to 256 KiB, then multiples of 256 KiB. The size tells only roughly how long the work is.

## Threat model

**Protected against:**

- **The relay operator, or anyone who copies its disk or traffic,** reading any template, work, name or comment. The tests record every request and every stored byte and find no plaintext. The relay also sees no template, because the template sits in the link's fragment.
- **A classmate,** even one who downloads every box in the drop box, reading another student's work or comments. In a simulated class of 30, no student opened anything that was not theirs.
- **A classmate replacing or deleting** someone else's submission. The relay refuses both with 403.
- **A forged "teacher" comment,** whether from a classmate or from the relay. It fails the check against the teacher's key and is not shown. A comment copied under a second name is shown only once.
- **The server that hosts the app** learning anything about the assignment. The fragment never reaches it.

**Not protected against (known limits):**

- **Who has the link.** Anyone with the link can hand in under any name. The teacher sees each submitter's own key, so two versions from the same student are grouped together, but the name is whatever the student typed. Share the link the way you would share a classroom code.
- **Filling the drop box.** A link holder can add junk until the box's limits are reached (2 MiB per object, 2,000 objects). The teacher sees "unreadable objects skipped". Make a new assignment if this happens.
- **Metadata.** The relay, and every link holder, can see how many boxes there are, their approximate sizes and when each one was added. The relay sees IP addresses while it serves a request and does not log them.
- **Withholding.** The relay can drop or delay boxes, because it cannot be forced to serve them. After handing in, the app reads the box back from the relay and checks that it matches byte for byte. The teacher's list shows what arrived.
- **A lost or compromised teacher device.** The assignment's key cannot be exported. If the device is lost, its submissions cannot be opened. If someone controls that device, they can read that assignment's submissions. Each assignment has its own key, so the damage stays within one assignment.
- **Anything already on a device.** Once a teacher opens a submission into a tab, or a student adds comments to a note, that text is ordinary note text on that device.
- **No forward secrecy.** Submissions are sealed to the assignment's long-lived key. Anyone who later gets that key can open the submissions of that assignment that they have kept.
- **Retention.** The relay deletes a drop box that no one has written to, and its teacher has not read, for 180 days. A student's link reading it does not keep it. Use **Delete from the relay** to remove it sooner.
