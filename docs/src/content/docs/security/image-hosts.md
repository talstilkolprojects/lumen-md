---
title: Allowed image hosts
description: See which sites may always load images in your notes, and revoke one or all of them.
---

An image from another site tells that site you opened the note. So Lumen
doesn't load it until you say so: the preview shows a placeholder with
**Load** (this image, until you reload the page) and **Always allow**
(every image from that site, in this browser).

## The list, and revoking

Command palette → **Privacy: allowed image hosts…** lists every site you
chose **Always allow** for.

- **Revoke** next to a site: its images wait for you again, at once — the
  preview shows the placeholder and nothing more is requested from that
  site. Images from it you loaded once with **Load** in this session are
  blocked again too.
- **Revoke all** does it for every site.

The list is kept in this browser (localStorage), not in your notes or your
vault, so another browser or device has its own.

The desktop app loads no images from other sites at all; there is nothing
to allow there.
