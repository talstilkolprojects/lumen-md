# lumen-skills

[Agent Skills](https://agentskills.io/specification) that teach outside agents (Claude Code, Codex, any agent
that reads `SKILL.md`) the file formats of [Lumen](https://lumen-md.vercel.app), a local-first, Hebrew-first
Markdown editor. MIT.

| Skill | Teaches |
| --- | --- |
| `lumen-bases` | `.base` files: filters, formulas, table and card views, sort, group, summaries |
| `lumen-frontmatter` | the YAML frontmatter Lumen reads: tags, aliases, dates, lists, links |
| `lumen-niqqud` | Hebrew vowel points: when to keep them, how to search and compare text with and without them |
| `lumen-sefaria-refs` | Jewish-source references (`בראשית א:א`, `Genesis.1.1`) and Lumen's source notes |
| `lumen-israeli-citation` | Israeli legal citation (rulings, laws, regulations, books, articles) |

## Install

Claude Code: copy the folders into `~/.claude/skills/` (every project) or `<project>/.claude/skills/`:

```bash
git clone https://github.com/talstilkol/lumen-md
cp -r lumen-md/packages/lumen-skills/skills/* ~/.claude/skills/
```

Codex and other agents: copy them into the folder your agent reads skills from (for example `.agents/skills/`).

Inside Lumen, skills live in the vault at `.lumen/skills/<name>/SKILL.md` and run from `/` in the AI prompt
or the command palette.
