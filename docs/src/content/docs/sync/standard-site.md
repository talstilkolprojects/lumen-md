---
title: Publish to Bluesky and the fediverse
description: Publish a note as a Standard.site document in your own AT Protocol account, so Bluesky shows it with a rich preview, readers like Leaflet show it in full, and Bridgy Fed can bring it to Mastodon.
---

Open a note and run **Publish to Bluesky (Standard.site)…** from the command
palette. Lumen asks for your handle and your site's address the first time.
Before anything is sent, it shows a confirmation: the record is **public and
permanent**, since relays and apps keep copies that removing it later can't
take back. Running the command again on the same note updates its record,
and **Remove from Bluesky (Standard.site)…** deletes it. Only the open note is
ever published; nothing is chosen for you and nothing is published in bulk.

Lumen has no server of its own for this. Publishing writes two records into
**your own** AT Protocol account (your PDS):

- a `site.standard.publication`, once: your site's address and name;
- a `site.standard.document` for each note: its title, a summary, the plain
  text, the Markdown itself and its tags.

Publishing the same note again updates the same record, and unpublishing
deletes it. The Markdown export stays the source. Before any record is
built, `<redact>` passages become `█████` (a passage that is never closed
hides everything after it), and HTML comments and `%%…%%` comments are
removed. This happens inside the publishing code itself, so no path can
publish the raw note.

## Logging in

Use your handle and an **App Password** (Bluesky → Settings → Privacy and
security → App passwords), never your main password. The App Password is
used for that one sign-in and is **not stored**. Lumen keeps only the
session's refresh token, in its secret store, so the next publish needs no
password. Revoking the App Password ends that too. Lumen
connects to your account only when you press Publish, Update or Unpublish,
and every request appears in the privacy ledger.

## Proving the site is yours

When you publish your notes as a site (*Publish to your own site*), the site
gets `/.well-known/site.standard.publication`, which holds your publication's
`at://` address. Each published page also gets
`<link rel="site.standard.document" href="at://…">`. Standard.site's checker
and Bluesky use these to confirm the site is yours, and Bluesky then shows
your links with a rich preview.

## Hebrew and direction

Standard.site has no language or direction field. Hebrew text carries its own
direction, and your site's pages set `lang` and `dir` themselves, so a Hebrew
note shows right to left in readers that follow the Unicode rules.

## The fediverse (Mastodon, WordPress, Ghost)

[Bridgy Fed](https://fed.brid.gy) bridges Standard.site documents to the
fediverse. To turn it on for your account, follow **@ap.brid.gy** from your
Bluesky account. Your published notes then reach people who follow you from
Mastodon. Edits to a note are not bridged; the first version is. To stop,
unfollow @ap.brid.gy.
