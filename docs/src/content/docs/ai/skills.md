---
title: Agent skills
description: Your own AI workflows as files in the vault — run them with "/" in the AI prompt or the command palette, with only the tools they declare and every change waiting for your approval.
---

A **skill** is a workflow you write once and run with `/`: "summarise what I
read this week", "sort the inbox", "check the citations in this note". It is a
folder in your vault with a `SKILL.md` file in the open
[Agent Skills](https://agentskills.io/specification) format, so the same file
also works in Claude Code and Codex.

## Run a skill

- In the **AI prompt**, type `/`: the skills appear under the box. Pick one,
  add what you want after its name (`/sort-inbox only this week's notes`) and
  press Enter.
- In the **command palette** (⌘K / Ctrl+K), type `/` to see the skills only.

A skill runs on the open note through Lumen's agent runtime, on your local
model first. Its answer, and every change it proposes, wait in the **review
screen**: nothing is written until you approve it.

## Starter skills

Lumen comes with six, in Hebrew:

| Skill | What it does |
| --- | --- |
| `/weekly-reading` — סכם את מה שקראתי השבוע | summarises the notes, clips and highlights of the last 7 days, with links |
| `/sort-inbox` — מיין את ה-inbox | proposes tags and a folder for each note in `inbox/` |
| `/book-breakdown` — פרק ספר לפרקים וכרטיסים | proposes a note per chapter, with question–answer cards |
| `/similar-notes` — מצא פתקים דומים | lists related notes, with one line on why |
| `/literature-matrix` — הכן מטריצת ספרות | proposes a table: source, question, method, findings, limits |
| `/check-citations` — בדוק ציטוטים | checks each quotation against its source note |

## Write your own

Create `.lumen/skills/<name>/SKILL.md` in the vault:

```markdown
---
name: meeting-actions
description: List the action items of the open meeting note, with owners. Use after a meeting.
allowed-tools: get_document
metadata:
  title-he: משימות מהפגישה
---
1. Read the open note.
2. List every action item as "- [ ] who: what (by when)".
```

- `name`: lowercase letters, digits and single hyphens, the same as the folder.
- `description`: what it does and when to use it.
- `allowed-tools`: the only tools the skill gets. Lumen's: `read_file`,
  `write_file`, `list_files`, `search_workspace`, `get_frontmatter`,
  `set_frontmatter`, `list_tags`, `get_document`, `get_selection`,
  `get_headings`, `replace_range` and the validators. Claude Code names map to
  them (`Read`, `Write`, `Edit`, `Grep`, `Glob`). A call to any other tool is
  refused. Skills never get network, Python or git tools.
- A skill in your vault with a starter's name replaces the starter.

## Skills from others

A skill that comes with a plugin, or from a vault someone shared with you, is
marked **untrusted**. The first time each version runs, Lumen shows where it
came from and which tools it asks for, and runs it only if you allow it. Its
instructions go through the injection guard, and every write or network call
it makes asks you again, on top of the review screen.

## lumen-skills: Lumen for outside agents

`packages/lumen-skills` (MIT) teaches Claude Code, Codex and other agents
Lumen's formats: `.base` views, frontmatter, niqqud, Sefaria references and
Israeli legal citation. Copy its folders into `~/.claude/skills/` (or your
agent's skills folder).
