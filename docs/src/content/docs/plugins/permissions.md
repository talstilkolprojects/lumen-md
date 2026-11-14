---
title: Permissions and safety scan
description: Before a sandboxed plugin installs, Lumen shows every permission it asks for in plain language; every version in the registry is scanned, and a version that fails is not shown.
---

A sandboxed plugin can do nothing until you allow it — see the
[plugin API](/plugins/api/). Two things make that choice informed.

## The install screen

**Plugin Gallery → Sandboxed plugins → Install…** opens a screen that lists,
before anything runs, every permission the plugin's manifest asks for:

| Permission | What it lets the plugin do |
|---|---|
| `document:read` | Read the note that is open |
| `document:write` | Change the note that is open (*sensitive*) |
| `vault:read` | Read any note in your vault (*sensitive*) |
| `vault:write` | Create and change notes in your vault (*sensitive*) |
| `commands` | Add commands to the command palette |
| `panel` | Show a side panel |
| `renderer` | Draw code blocks of its own language in the preview |
| `settings` | Keep its own settings |
| `storage` | Store its own data on this device |
| `clipboard:write` | Copy text to your clipboard (*sensitive*) |
| `notifications` | Show notifications |
| `network:<origin>` | Connect to that one address — and nowhere else (*sensitive*) |

Each line also shows the plugin's own reason (“Why: …”) and the version's
safety scan. **Install and allow** grants exactly what is listed; anything
else the plugin tries is refused by the sandbox, and every network request
appears in the privacy ledger. The code is scanned again right before it
runs, so the card can't describe a different copy.

## The safety scan

Every version in the registry (`public/plugins/examples/index.json`) is
scanned by `scripts/scan-plugins.mjs` into `scan.json`; the gallery shows
each version's card — a grade (A, B, C), a score out of 100, and what the
scan noted. **A version that fails is not shown and cannot be installed.**

The scan reads the code — it never runs it — and fails a version that:

- uses an API whose permission the manifest does not declare (for example
  writes to the note with only `document:read`);
- reaches the network without declaring it, or connects to an origin other
  than the one declared;
- runs code made from text (`eval`, `Function`, string timers), loads more
  code (`import`), or indexes `globalThis` / `lumen` with a computed key;
- is not valid JavaScript, is larger than 512 KB, or has a signature that
  does not verify.

It notes (and lowers the score for) permissions asked for but not used,
indirect use of the API, network addresses built while running, and a
missing or unknown signature.

To check a new version before publishing: add it to `index.json`, then
`node scripts/scan-plugins.mjs` (or `--check` to only verify).

## Reporting a problem

Every card and install screen has **Report a problem**, which opens an issue
with the plugin's id and version filled in.
