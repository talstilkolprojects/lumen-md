# Template Vault

An opinionated starter vault for Obsidian that gives you a clean structure for capturing notes, reviewing them over time, and organizing them with folder-based workflows and Bases views.

## Overview

## What This Project Does

This repository is a ready-to-use Obsidian vault template. It combines:

- capture areas for ideas, projects, references, clippings, and periodic notes
- starter documentation for learning Obsidian in the Sandbox area
- prebuilt `.base` files in [Bases](Bases) for database-like views over your notes

Use it as a personal knowledge base, journal, project hub, or as a starting point for your own vault conventions.

## Why This Project Is Useful

- Starts simple: the top-level folders already separate short-lived notes, long-term references, and planning cycles.
- Encourages consistent organization: Daily, Weekly, and Monthly folders make recurring review habits easier to maintain.
- Supports structured note collections: the `.base` files cover common domains such as books, people, places, projects, trips, and ratings.
- Includes onboarding material: the Sandbox area helps new Obsidian users learn links, formatting, and basic workflows.
- Stays local-first: content is stored as Markdown files, so your notes remain portable and easy to version with Git.

## Vault Layout

| Path | Purpose |
| --- | --- |
| [Daily](Daily) | Daily notes and journal-style capture |
| [Weekly](Weekly) | Weekly planning and review notes |
| [Monthly](Monthly) | Monthly planning and review notes |
| [Projects](Projects) | Active project notes |
| [Ideas](Ideas) | Early-stage thoughts and future work |
| [References](References) | Evergreen reference material |
| [Clippings](Clippings) | Saved excerpts and source material |
| [Meta](Meta) | Vault-level notes about process, systems, and maintenance |
| [Templates](Templates) | Insertable note templates for each folder type |
| [Bases](Bases) | Predefined Obsidian Bases definitions (`*.base`) |
| [Sandbox](Sandbox) | Obsidian onboarding guides and formatting examples |
| [Canvases](Canvases) | Visual canvases and whiteboard-style work |

## Get Started

### 1. Clone or download the vault

```bash
git clone https://github.com/masuda-so/Template-Vault.git
```

Or download the repository as a ZIP and extract it locally.

### 2. Open the folder in Obsidian

1. Install [Obsidian](https://obsidian.md/).
2. Choose Open folder as vault.
3. Select this repository folder.

### 3. Start with the built-in onboarding notes

- Read [ようこそ.md](ようこそ.md) for a guided vault tour and first-steps checklist.
- Open [Sandbox/Start here.md](Sandbox/Start%20here.md) for a hands-on Obsidian introduction.
- Continue with [Sandbox/Guides/Get started with Obsidian.md](Sandbox/Guides/Get%20started%20with%20Obsidian.md).

### 4. Enable Obsidian Core Plugins

Open **Settings → Core plugins** and turn on:

| Plugin | Purpose |
| --- | --- |
| **Templates** | Insert templates from the `Templates/` folder |
| **Daily notes** | Create date-stamped notes in `Daily/` with one click |
| **Bases** | Browse notes as tables or cards using the `.base` files in `Bases/` |

After enabling Templates, set **Settings → Templates → Template folder location** to `Templates`.

### 5. Begin using the folder structure

A practical starting workflow:

1. Capture quick thoughts in [Ideas](Ideas).
2. Move actionable work into [Projects](Projects).
3. Keep source material in [References](References) or [Clippings](Clippings).
4. Review open work in [Weekly](Weekly) and [Monthly](Monthly).

### 6. Explore Bases views

The [Bases](Bases) directory contains `.base` files for common collections such as books, music, people, places, projects, recipes, shows, and trips. Open them in Obsidian with the Bases feature enabled to browse related notes as tables or cards.

## Obsidian Configuration Policy

The `.obsidian/` directory is **not tracked** in this repository (see `.gitignore`).

Each user's Obsidian configuration—themes, installed plugins, workspace layout—is personal and device-specific. Tracking it would cause conflicts when multiple people use the same vault on different machines or with different Obsidian versions.

After cloning, enable the plugins listed in **Get Started → Step 4** above to restore the intended experience.

## About the `.claude/` Directory

The `.claude/` directory contains [Claude Code](https://claude.ai/code) configuration files, including skills and prompt context used during development of this repository. It is tracked intentionally so that contributors using Claude Code can benefit from the same context when working on vault structure improvements.

If you are not using Claude Code, you can safely ignore this directory.

## Usage Examples

The following examples are based on patterns from the obsidian-skills content under [.claude/skills](.claude/skills).

### 1. Obsidian Markdown note example

Create a note using wikilinks, callouts, and embeds:

```md
---
title: Project Alpha
date: 2024-01-15
tags:
  - project
  - active
status: in-progress
---

# Project Alpha

This project aims to [[improve workflow]] using modern techniques.

> [!important] Key Deadline
> The first milestone is due on ==January 30th==.

## Tasks

- [x] Initial planning
- [ ] Development phase
  - [ ] Backend implementation
  - [ ] Frontend design

## Notes

The algorithm uses $O(n \log n)$ sorting. See [[Algorithm Notes#Sorting]] for details.

![[Architecture Diagram.png|600]]
```

### 2. Bases file example

Create a `.base` file (for example, `tasks.base` in [Bases](Bases)):

```yaml
filters:
  and:
    - file.hasTag("task")
    - 'file.ext == "md"'

formulas:
  days_until_due: 'if(due, (date(due) - today()).days, "")'

views:
  - type: table
    name: "Active Tasks"
    filters:
      and:
        - 'status != "done"'
    order:
      - file.name
      - status
      - due
      - formula.days_until_due
```

### 3. JSON Canvas file example

Create a `.canvas` file (for example, `research.canvas` in [Canvases](Canvases)):

```json
{
  "nodes": [
    {
      "id": "8a9b0c1d2e3f4a5b",
      "type": "text",
      "x": 0,
      "y": 0,
      "width": 300,
      "height": 150,
      "text": "# Main Idea\\n\\nThis is the central concept."
    },
    {
      "id": "1a2b3c4d5e6f7a8b",
      "type": "text",
      "x": 400,
      "y": -100,
      "width": 250,
      "height": 100,
      "text": "## Supporting Point A\\n\\nDetails here."
    }
  ],
  "edges": [
    {
      "id": "3c4d5e6f7a8b9c0d",
      "fromNode": "8a9b0c1d2e3f4a5b",
      "fromSide": "right",
      "toNode": "1a2b3c4d5e6f7a8b",
      "toSide": "left"
    }
  ]
}
```

## Where To Get Help

- Start with the onboarding notes in [Sandbox](Sandbox).
- Check the official Obsidian help site: https://help.obsidian.md/
- Review formatting examples such as [Sandbox/Formatting/Format your notes.md](Sandbox/Formatting/Format%20your%20notes.md).
- If you find an issue in this repository, open an issue at https://github.com/masuda-so/Template-Vault/issues

## Status

## Quickstart

## Development

## Support

## License

## Maintainers And Contributing

This repository is maintained by Masuda So on GitHub as `masuda-so`.

Contributions are welcome, especially when they improve the default vault structure, note templates, onboarding flow, or Bases definitions.

To contribute:

1. Fork the repository.
2. Create a focused branch for your change.
3. Update or add notes with clear, minimal structure.
4. Open a pull request describing the workflow improvement.

If you plan to make a larger structural change, open an issue first so the folder layout and naming conventions can be discussed before implementation.

## Third-Party Notices

This repository includes content derived from kepano/obsidian-skills.
The required copyright notice and permission notice are provided in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), and must be included in all
copies or substantial portions of the relevant content.
