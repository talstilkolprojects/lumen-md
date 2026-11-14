---
title: Read-mode publishing
description: Publishing a note as a read-only web page — what exists today, the server it needs, and what is not built yet.
---

:::caution[Not in the app yet]
The publishing code exists (`src/sync/publish.ts`), but **no screen or
command calls it yet**. This page describes what is there, so a host can
set up the server side ahead of the button.
:::

## What it does

`publishNote()` sends a note to a publish server, which stores the rendered
page and answers with its public URL and slug. `unpublishNote()` makes it
private again. A note can be published as **public** or **unlisted**, and
with a password: the body is then encrypted on this device before it is
sent, so the server only ever holds ciphertext. The slug is kept in the
note's front matter (`published: <slug>`) so that publishing again updates
the same page. Publishing needs a plan with cloud features (Pro / Team).

## The server

Any HTTP endpoint that accepts the same JSON works. The reference is a
Cloudflare Worker in `edge-workers/publish`; the steps to deploy it are in
`DEPLOY.md` (section *Publish edge worker*). The app finds the server
through `VITE_PUBLISH_ENDPOINT` at build time. Without it, a development
build (or one on `localhost`) publishes into a local mock, and any other
build refuses with *“VITE_PUBLISH_ENDPOINT is not set”*.

The browser never holds a service key: requests carry the user's session.
