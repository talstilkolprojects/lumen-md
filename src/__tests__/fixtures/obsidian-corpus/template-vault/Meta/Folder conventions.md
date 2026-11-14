# Folder conventions

Reference note for folder purposes, naming rules, and the note lifecycle inside this vault.

## Folder index

| Folder | What belongs here | What does not belong here |
| --- | --- | --- |
| `Daily/` | Date-stamped journal entries, daily logs, short-lived tasks | Long-term knowledge, project planning |
| `Weekly/` | Weekly review and planning notes | Day-to-day captures |
| `Monthly/` | Monthly review and goal-setting notes | Weekly granularity |
| `Projects/` | Active work with defined outcomes and next actions | Completed or abandoned work, vague ideas |
| `Ideas/` | Early-stage, exploratory notes not yet ready to act on | Committed work with deadlines |
| `References/` | Evergreen notes, source summaries, durable knowledge | Dated logs, active tasks |
| `Clippings/` | Saved excerpts, web captures, and raw source material | Processed summaries (those go to References) |
| `Templates/` | Reusable note templates inserted via the Templates plugin | Filled-in notes |
| `Bases/` | Obsidian Bases definitions (`.base` files) | Regular Markdown content |
| `Canvases/` | Visual canvases and whiteboard-style diagrams | Text-only notes |
| `Sandbox/` | Obsidian onboarding guides and formatting examples | Production notes |
| `Meta/` | Vault-level operating notes: conventions, policies, review cadences | Subject-matter content |

## Naming rules

| Scope | Convention | Example |
| --- | --- | --- |
| Daily notes | `YYYY-MM-DD` | `2026-04-01` |
| Weekly notes | `YYYY-Www` | `2026-W14` |
| Monthly notes | `YYYY-MM` | `2026-04` |
| Project notes | Short slug, lowercase with hyphens | `refresh-vault-readmes` |
| Idea notes | Short descriptive phrase | `weekly-review-prompts` |
| Reference notes | Topic name or author–title style | `zettelkasten-method` |
| Clipping notes | Source slug or date-prefixed slug | `2026-04-01-article-title` |

Avoid spaces in filenames when possible; use hyphens instead. Obsidian handles spaces in wikilinks with `%20` encoding, which reduces readability.

## Note lifecycle

```
Ideas/ ──── (actionable) ──▶ Projects/ ──── (done or abandoned) ──▶ #archived
  │                                │
  │                                └── (durable knowledge extracted) ──▶ References/
  │
  └── (captures and sources) ──▶ Clippings/ ──── (processed) ──▶ References/
```

### Lifecycle stages

| Stage | Tag | Location |
| --- | --- | --- |
| Exploring | `#idea` | `Ideas/` |
| Active | `#active` | `Projects/` |
| Paused | `#paused` | `Projects/` |
| Evergreen | — | `References/` |
| Archived | `#archived` | See [[Archive policy]] |

## Frontmatter conventions

Use consistent frontmatter keys to enable Bases views and filtering:

```yaml
---
type: project          # project | idea | reference | clipping | daily | weekly | monthly
status: active         # active | paused | done | abandoned
created: 2026-04-01
reviewed: 2026-04-01
tags:
  - project
---
```

## Where To Get Help

- For the vault-wide structure, see [README.md](../README.md).
- For archive rules, see [[Archive policy]].
- For recurring review checklists, see [[Review cadence]].

## Maintainers And Contributing

Update this note whenever a folder boundary changes, a new folder is added, or a naming rule is revised. Cross-link to [README.md](../README.md) if the top-level layout table is also updated.
