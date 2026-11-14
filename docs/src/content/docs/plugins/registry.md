---
title: Plugin registry and the built-in ten
description: The ten plugins in Lumen's plugin gallery, what each one may do, and how the static registry is built and scanned.
---

The **Sandboxed plugins** section of the Plugin Gallery lists plugins from a
static registry that ships with Lumen. There is no plugin server: the registry
is a folder of files, and every version in it passes the safety scan before it
is listed.

## The ten plugins

These are modelled on the kinds of Obsidian plugins people download most
(templates, task boards, calendars, tables, linting, tags, spaced repetition,
refactoring, dates, sorting). Each is written for Lumen's sandbox: none of them
uses the network, so they all work under the **local-only** AI policy.

| Plugin | What it does | Permissions |
| --- | --- | --- |
| **Templates** | Inserts a note from your `Templates` folder, filling `{{date}}`, `{{date:DD/MM/YYYY}}`, `{{time}}`, `{{title}}`, `{{selection}}`, `{{weekday}}` and `{{hebrewWeekday}}`. | commands, read the vault, read and change the open note, panel, settings |
| **Kanban board** | Draws a ` ```kanban ` block (a `## heading` per column, a `- item` per card) as columns, and copies the board as a Markdown table. | code-block renderer, commands, read and change the open note, clipboard, notifications |
| **Calendar** | A month view of your daily notes (`YYYY-MM-DD.md`). Days that have a note link to it. The week starts on Sunday, or on Monday if you choose. | commands, panel, read the vault, settings |
| **Table formatter** | Lines up the columns of every table and sorts a table by the column under the cursor. Hebrew niqqud takes no width. | commands, read and change the open note |
| **Markdown tidy** | Fixes trailing spaces, extra blank lines, heading spacing, mixed bullets and a missing final newline. It never touches code or front matter. | commands, read and change the open note, notifications, settings |
| **Tag manager** | Lists every `#tag` in the vault, Hebrew tags included, and renames a tag and its nested tags everywhere at once. | commands, panel, read and change the vault, notifications |
| **Flashcards** | Turns `question :: answer` lines into cards and schedules reviews with SM-2. The note itself is never changed. | commands, read the open note, panel, storage |
| **Note refactor** | Moves the selection into a new note and leaves a `[[link]]` in its place, or splits a note into one note per heading. | commands, read and change the open note, read and change the vault, notifications, settings |
| **Natural dates** | Turns “tomorrow”, “next Friday”, “in 3 days”, “מחר”, “יום שישי הבא” or 12/11/2026 (day first) into `[[2026-11-13]]`. | commands, read and change the open note, notifications, settings |
| **Sort lines** | Sorts the selected lines A→Z, Z→A or by length, reverses them, or removes duplicates. Sub-items stay with their item. Hebrew sorts by letter (final letters sort with their regular forms), and numbers sort by value. | commands, read and change the open note, notifications |

Install one from **Plugin Gallery → Sandboxed plugins → Install…**. The
permission screen lists everything the plugin asks for and why. Once a plugin is
installed, its card shows **Remove**, which stops the plugin and deletes the
settings and data it stored.

The plugins write their labels in English and Hebrew, because the plugin API
does not tell a plugin which language the app is in.

## How the registry is built

```
public/plugins/examples/
  index.json          ← built: every plugin, its versions, the SHA-256 of each version's code
  scan.json           ← built: the safety scan of every version
  kanban/             ← one folder per version
    lumen-plugin.json
    main.js
```

```sh
node scripts/build-plugin-registry.mjs           # rebuild index.json and scan.json
node scripts/build-plugin-registry.mjs --check   # fail if either is out of date or a version fails
```

The build does the following:

- validates every manifest;
- refuses stray files in a plugin folder (only the manifest, its entries, a `LICENSE` and a `README` are allowed);
- refuses an id and version that appear twice;
- writes `index.json`;
- scans every version (`scripts/scan-plugins.mjs`).

A new version goes in a folder of its own, for example `kanban@1.1.0`.

When you install a plugin, the app scans the downloaded code again. It refuses
the code if its SHA-256 differs from the hash in the registry scan.

## A registry site of its own

The same registry can be published as a static site of its own on Cloudflare
Pages, the second host. A developer outside the project can then get a plugin
listed with a pull request, without waiting for an app release.

```sh
npm run registry:site                 # builds dist-registry/ (it first checks that index.json and scan.json are current)
npm run registry:verify -- dist-registry
npx wrangler pages deploy dist-registry --project-name lumen-md-plugins --branch main
npm run registry:verify -- https://lumen-md-plugins.pages.dev
```

The site holds:

- `v1/index.json`: every plugin and every version that passed its scan, with
  its permissions, its scan grade and findings, and the SHA-256 and size of
  each file. A version that failed its scan is left out.
- `v1/plugins/<id>/<version>/`: the files. They are served as text and never
  rewritten, so they can be cached forever.
- `SHA256SUMS`, in the format `sha256sum -c` reads.
- `index.html`: the list, in Hebrew and English, with no scripts.
- `_headers`: `nosniff`, read-only CORS, and a CSP that allows nothing to run.

`registry:verify` recomputes every hash and **scans every version again**
on your machine. A host that changed a file, or that lists a version the scan
would refuse, fails the check. The site fits the free plan with room to
spare: 40 files of the 20,000 allowed, 4 header rules of the 100 allowed.

The app still reads the registry it ships (`/plugins/examples`). Reading this
site from the app is a separate step, because the app's CSP would need its
address.

## Not yet

- The plugins are **unsigned**, so their cards show the “unsigned” note.
  Signing them needs the owner's key; see [Plugin signing keys](/plugins/signing/).
