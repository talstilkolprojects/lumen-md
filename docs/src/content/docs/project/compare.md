---
title: Lumen, Obsidian, Notion and Google Docs
description: An honest comparison for people who write in Hebrew: what each one does, with a source for every claim, and what Lumen still lacks.
---

Each one is good at something. This page says what each does on five points that matter when you write in Hebrew, and every claim links to where it can be checked. Claims about the other products come from their own pages.

## Price

| | What it does | Sources |
|---|---|---|
| **Lumen** | Free. In the browser there is nothing to install, and notes stay in the browser's private storage. | [Lumen docs](/getting-started/install/) · <https://github.com/talstilkol/lumen-md/blob/main/LICENSE> (Checked 2026-11-10) |
| **Obsidian** | Free, for personal use and, since February 2025, for work too. Sync is a paid add-on ($4 a month, billed yearly). | <https://obsidian.md/blog/free-for-work/> · <https://obsidian.md/pricing.html> (Checked 2026-11-10) |
| **Notion** | A free plan and paid plans; see Notion's pricing page. | <https://www.notion.com/pricing> (⚠ not yet verified) |
| **Google Docs** | Free with a Google account; Google Workspace plans for organisations. | <https://workspace.google.com/pricing> (⚠ not yet verified) |

## Hebrew and right-to-left

| | What it does | Sources |
|---|---|---|
| **Lumen** | Interface in Hebrew with a mirrored layout; direction per line; search that ignores niqqud and Hebrew prefixes. | [Lumen docs](/editor/hebrew/) (Checked 2026-11-10) |
| **Obsidian** | Since version 1.6: a mirrored interface for right-to-left languages, Hebrew among them, and notes in RTL, LTR or both. | <https://docs.obsidian.md/Plugins/User+interface/Right-to-left> (Checked 2026-11-10) |
| **Notion** | Interface in Hebrew, mirrored in the desktop and mobile apps; text direction detected in most blocks, but not in simple tables. | <https://www.notion.com/help/change-your-language> (Checked 2026-11-10) |
| **Google Docs** | Right-to-left controls turn on for documents with RTL text; paragraph direction and table column order can be set. | <https://support.google.com/docs/answer/65166> (Checked 2026-11-10) |

## Working offline

| | What it does | Sources |
|---|---|---|
| **Lumen** | The installed web app opens and works without a network; notes are stored on the device. | [Lumen docs](/getting-started/install/) (Checked 2026-11-10) |
| **Obsidian** | Notes are files in a folder on the device, so they open without a network. | <https://help.obsidian.md/data-storage> (⚠ not yet verified) |
| **Notion** | Since August 2025, offline in the desktop and mobile apps (not the browser): downloaded pages, plus Recents and Favorites on Plus, Business and Enterprise. | <https://www.notion.com/releases/2025-08-19> (Checked 2026-11-10) |
| **Google Docs** | Offline editing in Chrome or Edge with the Google Docs Offline extension, turned on per account. | <https://support.google.com/docs/answer/6388102> (⚠ not yet verified) |

## Markdown files

| | What it does | Sources |
|---|---|---|
| **Lumen** | Every note is a plain Markdown file; the whole vault exports as a .zip or a folder. | [Lumen docs](/workspace/export-import/) (Checked 2026-11-10) |
| **Obsidian** | Notes are Markdown files. | <https://help.obsidian.md/data-storage> (⚠ not yet verified) |
| **Notion** | Pages live in Notion's database; they can be exported as Markdown. | <https://www.notion.com/help/export-your-content> (⚠ not yet verified) |
| **Google Docs** | Since July 2024, import Markdown as a Doc and export a Doc as Markdown. | <https://workspaceupdates.googleblog.com/2024/07/import-and-export-markdown-in-google-docs.html> (Checked 2026-11-10) |

## Source code

| | What it does | Sources |
|---|---|---|
| **Lumen** | Open source under the MIT licence. | <https://github.com/talstilkol/lumen-md/blob/main/LICENSE> (Checked 2026-11-10) |
| **Obsidian** | The app's source code is not published. | <https://obsidian.md/license> (⚠ not yet verified) |
| **Notion** | Proprietary. | <https://www.notion.com/terms> (⚠ not yet verified) |
| **Google Docs** | Proprietary. | <https://policies.google.com/terms> (⚠ not yet verified) |

## What Lumen still lacks

- No sync service of its own yet: between devices, keep the vault in a folder you already sync, or export and import. ([Lumen docs](/workspace/export-import/))
- Real-time co-editing is peer to peer and young; Google Docs and Notion are far ahead for teams. ([Lumen docs](/collab/webrtc/))
- Far fewer plugins and templates than Obsidian's community. ([Lumen docs](/plugins/sdk/))
- The phone apps are not in the App Store or Google Play yet; on a phone Lumen runs in the browser or as an installed web app. ([Lumen docs](/getting-started/install/))
- It is a beta: expect rough edges, and keep a backup (Export the whole vault). ([Lumen docs](/workspace/export-import/))

> A claim marked *not yet verified* has a source that hasn't been checked yet. It is checked before the launch.

This page is generated from `launch/comparison.json` by `node scripts/launch-check.mjs --write`. To correct a claim, change the JSON with a source, and the page follows.
