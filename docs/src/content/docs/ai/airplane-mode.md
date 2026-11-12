---
title: Airplane mode and the network monitor
description: One switch that stops every network request Lumen can make, a live list of every attempt with where in the code it came from, and a certificate of the time it was on.
---

**Airplane mode (no network)** in the command palette stops every request Lumen could
send over the network, from the moment you turn it on. **Network monitor** lists every
attempt live, whether it was allowed, blocked, local or served from the cache, and shows
where in the code it came from. A badge in the corner shows that the mode is on.

## What it stops

| Path out | While airplane mode is on |
|---|---|
| `fetch` to another site | refused before it runs |
| `fetch` to Lumen's own server | GET only, and only from a cache (`only-if-cached`): never the network |
| `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, WebRTC peers | refused. Live-collaboration sockets that were open are closed |
| Workers (model downloads) | the worker asks its own page and refuses the request itself. A worker that gets no answer refuses too. Another tab of Lumen can't answer for it, and once it has heard "on" it stays on until the page reloads. A tab that sees the mode turned on in another tab turns it on too |
| Images, fonts, media, frames, stylesheets from other sites | refused by the browser itself: a Content-Security-Policy is added to the page |
| Playground and live-JS blocks | they don't run. Their runner page is a separate frame with its own policy, so the page's policy can't cover it. Frames load only from `blob:` while the mode is on. A block that was already running when you turned the mode on is stopped at that moment |
| HTML and Live CSS previews, embeds and other open frames | a frame keeps the policy it was opened with, and CSS alone can load images, so every frame with something in it is closed (emptied) when you turn the mode on, whatever its sandbox, and listed in the certificate. Windows the app opened are closed too |
| Cloud dictation (the browser's speech service) | not started |

These stay allowed, because they don't leave the computer: `localhost` / `127.0.0.1`
(a local model such as Ollama on this machine), `blob:` and `data:`.

A browser can't lift a Content-Security-Policy from a page that is already open. So
turning airplane mode **off reloads the page**. Save your work first. The mode stays on
across reloads until you turn it off, and the policy is in place before the app starts.

## The monitor and the certificate

Each row shows the time, the kind of request, the decision, the destination (address
and path only, never the query) and where it came from in the code. The code location
is the calling function and file, as the browser reports it. **Try a request** sends a
test request to `example.com`, so you can watch it appear as blocked.

While the mode is on, **Download certificate** saves a file that states the time span
and lists every attempt in it, with a count of how many reached the network (the claim
is 0). It counts attempts, not bytes:

- every request the page and its workers made through the wrapped network calls;
- every resource load the browser lists. A load from another site counts as reaching the
  network even when the browser reports 0 bytes (it hides the size of other sites' files);
- every request, socket, peer or frame that could make requests (playground, HTML preview
  with scripts, embed) still open when you turned the mode on. These count as
  having reached the network, and are stopped at that moment.

The file also lists what it doesn't prove (`notCounted`). For example, a request made
through a copy of `fetch` that a library took before the wrappers loaded isn't listed,
although the page's policy still refuses it to any other site. The file is canonical
JSON with its SHA-256. It is not signed yet: signing with this device's key comes with
the signed privacy report.

## Limits

- A site embedded in a note can't open a window, and only the known embed providers
  (YouTube, Vimeo and the others of the embed block) keep a storage of their own. A
  service worker one of them registered before you turned the mode on is outside the
  page and may keep running.

- Lumen's own script files that the offline cache doesn't hold load from Lumen's server,
  like any page resource; they are not `fetch` requests. The monitor sees them through
  the browser's Resource Timing, and the certificate counts any that transferred bytes
  as having reached the network.
- The plan's full check is the owner's to run: 22 commands under `mitmproxy`, with 0
  requests while the mode is on. `e2e/airplane-mode.spec.ts` checks the same promise
  against fake hosts.
