---
title: Publish to Bluesky and the fediverse
description: Publish a note as a Standard.site document in your own AT Protocol account, so Bluesky shows it with a rich preview, readers like Leaflet show it in full, and Bridgy Fed can bring it to Mastodon.
---

:::note[Status]
The publishing engine and the site's ownership proof are in place and tested.
The Publish button and the login screen come in the next release.
:::

Lumen has no server of its own for this. Publishing writes two records into
**your own** AT Protocol account (your PDS):

- a `site.standard.publication`, once: your site's address and name;
- a `site.standard.document` for each note: its title, a summary, the plain
  text, the Markdown itself and its tags.

Publishing the same note again updates the same record, and unpublishing
deletes it. The Markdown export stays the source, and `<redact>` passages are
removed as in every export.

## Logging in

Use your handle and an **App Password** (Bluesky → Settings → Privacy and
security → App passwords), never your main password. The App Password is
kept only in Lumen's secret store, and the session lives only in memory. Lumen
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
