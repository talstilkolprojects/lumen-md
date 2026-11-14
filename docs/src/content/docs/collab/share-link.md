---
title: Encrypted share link
description: Share a read-only copy of one note as a link that carries the note itself, encrypted. No server, no account.
---

**Share as encrypted link** (command palette) turns the open note into a link. The note
is compressed and encrypted on your device and travels **inside the link**. Whoever opens
the link sees a read-only copy, decrypted in their own browser. Nothing is uploaded, and
neither of you needs an account.

## Why no server sees it

The link looks like this:

```text
https://lumen-md.vercel.app/#view=<encrypted note>&key=<key>
```

Everything after `#` is the *fragment*. Browsers never send it to a server: it is not
part of the request, and it is not in the `Referer` header. So the server that serves
Lumen gets a plain request for its home page, with no byte of the note or of the key.
The tests check this: `e2e/share-link.spec.ts` records every request the viewer makes,
its headers and its body included.

- **Encryption:** AES-GCM with a 256-bit key, made at random for each link (WebCrypto).
  If one character of the link changes, or the key is wrong, the note does not open. It
  never shows altered text.
- **Compression:** `deflate-raw` (CompressionStream) runs before encryption, so a typical
  note of 20 KB makes a link of about 7,000 to 11,000 characters.
- **Read-only:** the viewer shows the note. It does not save the note into the
  recipient's notes, but they can copy the Markdown or download it as `.md`.

## Options

- **Expires:** never, or after 1, 7 or 30 days. The date is inside the encrypted note,
  and the viewer refuses the note after it. This is a promise of the viewer, not of the
  cryptography: the link still holds the note, so someone who kept it could decode it by
  hand.
- **Send the key separately:** you get the link without its key, and the key on its
  own. Send them by two different routes (for example, an email and a message). Someone
  who opens the link without the key is asked to paste it.

## Large notes

A link holds at most 32,768 characters of encrypted data, so that it stays usable in
browsers and in messaging apps. For a larger note, the dialog offers an **encrypted
file** (`.lumenshare`) and a short link that holds only its key. The recipient opens the
link and picks the file. The file is decrypted on their device too.

Opening a link or a file inflates the note at most 100 times its compressed size,
so a crafted link can't freeze the viewer. Every note Lumen shares fits that bound.

## Which address the link opens

A link opens the viewer on a web address the recipient can reach. A link made in the
desktop or mobile app, or on `localhost`, names the public app,
`https://lumen-md.vercel.app` (a build can name another one with `VITE_SHARE_ORIGIN`).
A Lumen served over https from a public host keeps its own address.

## Who can read it

Anyone who has the whole link (or the file and its key link), and nobody else. Treat
the link like the note itself: don't post it where others can read it.
