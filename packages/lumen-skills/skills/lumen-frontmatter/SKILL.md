---
name: lumen-frontmatter
description: Write the YAML frontmatter Lumen notes use (tags, aliases, dates, status, links, lists) so Lumen's search, Bases and properties panel read it. Use when creating or editing Lumen notes' properties.
license: MIT
---

# Lumen frontmatter

A note may start with YAML between `---` lines. Lumen reads it in search, Bases and the properties panel.

```markdown
---
title: תכנית השקה
tags: [project, השקה]
aliases: [Launch plan]
status: doing
priority: 2
due: 2026-12-01
people: ["[[דנה]]", "[[Omer]]"]
---
# תכנית השקה
```

1. `tags` is a list without `#`. Hebrew tags are fine. Nested tags use `/` (`project/q4`).
2. Dates are ISO (`2026-12-01`, `2026-12-01T09:30`). Lumen shows them in the reader's calendar, including the Hebrew one.
3. Links in properties are quoted wiki links: `"[[Note]]"`.
4. Keep keys stable and lowercase English unless the vault already uses Hebrew keys. Do not rename a key the
   vault's `.base` files use.
5. Never put secrets in frontmatter: it syncs and exports with the note.
6. Change only the keys you were asked to change, and keep the rest byte for byte.
