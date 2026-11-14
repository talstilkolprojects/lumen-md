---
title: Publish to Bluesky and the fediverse
description: Publish notes as Standard.site documents on your own AT Protocol account, and reach Mastodon through Bridgy Fed, with no server of yours.
---

Lumen can publish a note to **your own AT Protocol account** (the network behind Bluesky)
as a [Standard.site](https://standard.site) document. Readers such as Leaflet show it as an
article, and Bluesky shows a rich preview of links to it. The Markdown note stays the source;
the record is a copy that Lumen replaces each time you publish.

## Publish

1. Open **Publish site…** from the command palette and pick the notes.
2. Tick **Also publish to my AT Protocol account**.
3. Fill in your **handle** (`name.bsky.social` or your own domain) and an **App Password**
   (Bluesky: *Settings → Privacy and security → App passwords*). Never use your main password.
4. Fill in the **site address**: where the static site is served (for example your GitHub
   Pages address).
5. **Publish**. Each note gets a document record with its title, a summary (the frontmatter's
   `description`, or the start of its first paragraph), its language and its direction (a
   Hebrew note is marked right to left), and its tags.

The note keeps `atproto-document: at://…` in its frontmatter. Publishing it again replaces the
same record instead of making a new one. **Remove the picked notes from the AT Protocol** deletes
their records and that line; the notes themselves stay.

## Prove the site is yours

The site Lumen builds now includes:

- `/.well-known/site.standard.publication`, holding the publication's `at://` address;
- a `<link rel="site.standard.document" href="at://…">` tag on every published page.

Upload the site as usual (the zip, or GitHub Pages), then check it with Standard.site's
validator.

## The fediverse (Mastodon, WordPress, Ghost) through Bridgy Fed

You don't need to run an ActivityPub server. Since March 2026, [Bridgy Fed](https://fed.brid.gy)
bridges Standard.site articles to the fediverse:

1. On Bluesky, follow `@ap.brid.gy`. Bridgy Fed then bridges your account, and it appears on
   the fediverse as `@yourhandle@bsky.brid.gy`.
2. Publish from Lumen as above. Bridgy Fed sends each new document to your fediverse followers
   as an article, with its title and summary and a link to the page.
3. To stop, block `@ap.brid.gy` on Bluesky.

## Privacy and security

- The calls go from the app straight to your account: the handle lookup (`bsky.social`), your
  DID document (`plc.directory`) and your PDS (`*.bsky.network`). They happen only when you
  publish or remove, and the privacy ledger lists them.
- The App Password and the session token are kept in the device's secret store (the system
  keychain in the desktop app, encrypted storage in the browser). They are never written to the
  vault, to `localStorage` or to the logs.
- A self-hosted PDS works too once the deployment adds its address to the app's
  `connect-src` (see Self-hosting).
