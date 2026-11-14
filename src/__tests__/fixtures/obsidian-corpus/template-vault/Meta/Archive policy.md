# Archive policy

Defines how and when notes are archived in this vault.

## Strategy

This vault uses a **tag-only** archive approach.

- Add the `#archived` tag to the note's frontmatter.
- Leave the note in its current folder.
- Do not move it to a separate `Archives/` folder unless the volume of archived notes makes a folder necessary.

This keeps wikilinks intact, avoids link rot, and requires no folder restructuring.

> [!note] Revisiting this decision
> If archived notes begin to clutter search results or Bases views, consider filtering them out by `status != "archived"` in the relevant `.base` file rather than moving the files.

## Scope

The archive policy applies to all note types:

| Folder | Archived when |
| --- | --- |
| `Projects/` | The project is completed or abandoned |
| `Ideas/` | The idea is discarded or superseded by a project or reference note |
| `References/` | The note is outdated and no longer useful as a reference |
| `Clippings/` | The source is no longer relevant and has not been promoted |

Notes in `Daily/`, `Weekly/`, and `Monthly/` are historical records and do not need to be archived. They stay in place permanently.

## Triggers

Archive a note when any of the following conditions is true:

- **Completed**: the project or idea reached its intended outcome.
- **Abandoned**: the project or idea was consciously dropped and will not be resumed.
- **Inactive**: the note has not been reviewed or updated in more than six months and is no longer relevant.
- **Superseded**: a newer note covers the same topic and the older one adds no distinct value.

## How to archive a note

1. Open the note.
2. Set `status: archived` in the frontmatter.
3. Add `#archived` to the `tags` list.
4. Optionally add an `archived` date field for tracking.

Example:

```yaml
---
type: project
status: archived
archived: 2026-04-01
tags:
  - project
  - archived
---
```

## Where To Get Help

- For folder boundaries and naming rules, see [[Folder conventions]].
- For review triggers and cadence, see [[Review cadence]].
- For the vault-wide structure, see [README.md](../README.md).

## Maintainers And Contributing

Update this note if the archiving strategy changes, for example if a dedicated `Archives/` folder is introduced or if the inactivity threshold is adjusted.
