---
title: What's new
description: After an update, Lumen shows that version's release notes once, in your interface language.
---

When Lumen updates, the next time you open it you see **What's new**: that
version's release notes, in the language of your interface. They appear
**once per version**. A new install doesn't show them, since nothing is new
to you yet.

To read them again at any time, run `⌘K → "What's new in this version"`.

The notes ship inside the app, so they work offline.

## For maintainers: where the notes come from

- **English** is `CHANGELOG.md`, which `node scripts/release.mjs prepare`
  writes from the commit subjects (see `RELEASE.md`). Commit links and
  scopes are left out of what readers see.
- **Other languages** live in `changelog/<locale>.md`, for example
  `changelog/he.md`, with the same `## [x.y.z] - date` sections.
  `release.mjs prepare` copies each new English section into every file
  there, marked `<!-- untranslated -->`.
- To translate a release, translate the section and delete that line.
  Until then the app shows the English notes under the language's own
  headings, and says they aren't translated yet.
