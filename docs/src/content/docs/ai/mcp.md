---
title: MCP integration (Claude Desktop, Cursor, …)
description: Expose your Lumen workspace as a Model Context Protocol server so any AI agent can read, write, and search your notes.
---

Lumen ships an [MCP](https://modelcontextprotocol.io/) server out of the
box. Configure it once and Claude Desktop / Cursor / any MCP-aware
client can read your workspace, write new notes, and run substring
searches — from inside the chat, with no extra UI.

## Install

The server isn't published to npm yet, so build it from the repository
(Node 22 or later):

```bash
git clone https://github.com/talstilkol/lumen-md
cd lumen-md/mcp-server
npm ci
npm run build          # → mcp-server/dist/index.js
```

## Configure Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lumen": {
      "command": "node",
      "args": ["/path/to/lumen-md/mcp-server/dist/index.js"],
      "env": {
        "LUMEN_WORKSPACE": "/Users/you/Documents/Lumen"
      }
    }
  }
}
```

Restart Claude Desktop. A 🔌 icon appears in the chat input — your
Lumen workspace is now part of Claude's context.

## Tools the agent gets

| Tool | Args | Returns |
| --- | --- | --- |
| `read_note` | `path` | The full markdown body |
| `write_note` | `path`, `content` | Confirmation string |
| `list_notes` | — | Newline-separated list of every `.md` / `.txt` |
| `search_workspace` | `query`, `limit?` | Substring matches with line numbers |
| `append_note` | `path`, `content` | Adds to the end of an existing note |
| `delete_note` | `path`, `confirm: true` | Refuses without `confirm: true` (safety guard) |
| `update_frontmatter` | `path`, `set?`, `unset?` | Patch YAML keys; body untouched |
| `list_tags` | — | Tag → count map across the whole workspace |
| `get_backlinks` | `path` | Notes that contain `[[wiki-link]]` to this one |

## Examples

> *Read my note about deep learning and summarise the open questions.*

Claude calls `search_workspace("deep learning")` → top hits → `read_note`
on each → composes a summary with citations linking back to your notes.

> *Capture my last 5 messages as a new note titled "Meeting prep — Q3".*

Claude calls `write_note("meetings/2026-q3-prep.md", "...")` — your note
is written to `LUMEN_WORKSPACE` at once; the web app sees it after the
next Git pull (see below).

> *Tag every note under `2024/` as archived.*

Claude calls `list_notes` → filters to `2024/` → loops
`update_frontmatter(path, { set: { status: "archived" } })`. Bodies stay
intact; only frontmatter is rewritten.

> *Which notes link to "Project Aurora"?*

Claude calls `get_backlinks("projects/project-aurora.md")` → returns
every note containing `[[Project Aurora]]`.

## Security boundary

The server **refuses any path containing `..` or absolute paths**. An
agent can only see files under `LUMEN_WORKSPACE`. Run the server only
against directories you'd be comfortable showing the agent.

## Sync with the web app

The MCP server is a Node process — it can't reach OPFS in your browser
directly. The standard pattern: bind your Lumen workspace to a Git repo
(`⌘K → Git: clone repository…`), clone the same repo to the path you set
in `LUMEN_WORKSPACE`, and use `git pull` / push to keep both sides in sync.
