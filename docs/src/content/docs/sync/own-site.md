---
title: Publish to your own site
description: Turn the notes you pick into a website with navigation, search and right-to-left pages, on your own GitHub Pages or as a .zip for any static host.
---

`⌘K → Publish site…` turns the notes you pick into a static website that
you host yourself. Lumen runs no server for it, and the site belongs to you.

## What you get

- **A page per note**, rendered by the same pipeline as the preview and the
  HTML export: diagrams, math, tables and code.
- **Navigation** on every page: a tree of the published notes by folder, with
  the current page marked, and a link home.
- **Search** in the site bar. It runs in the visitor's browser over the site's
  own `search-index.json`, ignores case and Hebrew niqqud, and sends nothing
  anywhere.
- **Right-to-left.** A Hebrew or Arabic note is laid out right-to-left. With
  the site language set to Hebrew, the bar, navigation and search are
  right-to-left and in Hebrew too.
- **Links work.** `[[wiki links]]` and `.md` links point at the published
  pages. A link to a note you did not pick keeps its text but loses the link,
  so the site has no dead links and does not reveal where an unpublished note
  lives. Images and other files the notes reference are copied along. A file
  that cannot be found stays a plain link, and the result says how many.
- `index.md` at the vault root becomes the home page. Without one, the home
  page lists every page. A `404.html` and a `.nojekyll` are included.

## Where it goes

**A .zip file.** Download the site and put it on any static host: drag it
onto [Netlify Drop](https://app.netlify.com/drop), upload it to Cloudflare
Pages, or unpack it on a web server. Nothing leaves your device until you do.

**GitHub Pages.** Give the repository (`owner/name`, or its URL), a branch
(default `gh-pages`) and a GitHub token that may write to the repository's
contents and Pages. If you leave the token empty, the token of
[git sync](/sync/git/) is used. Publishing makes **one commit** on that branch,
on top of its previous one (no force push), so every earlier version stays in
its history. The commit holds exactly the site, so a page you unpublish is
gone from the next version. Lumen then switches Pages on for that branch and
shows the address. GitHub can take a minute before it serves a new version.

The repository needs at least one commit (a README is enough). An empty
repository is refused with that message. Only the site's files are sent, only
to `api.github.com`, and only when you press **Publish**. The token is kept on
your device.

The form remembers the site title, language, target, repository, branch and
your pick of notes.

## Not included

- Embeds (`![[note]]`) are published as written. They appear once the embed
  renderer (plan 4.7) is part of this build.
- Netlify and Cloudflare Pages deploys through their APIs (the .zip covers them
  today), and RSS.
