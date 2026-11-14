# @lumen-md/mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io/) server that
exposes a Lumen workspace to AI agents — Claude Desktop, Cursor, Cline, or
any MCP-aware client. Once configured, you can say "read my note about X"
and the agent finds, reads, or writes files in your workspace transparently.

## Install

Not published to npm yet — build it from the repository (Node 22+):

```bash
cd mcp-server
npm ci
npm run build          # → dist/index.js
```

## Configure Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) — or the equivalent on Windows / Linux — and add:

```json
{
  "mcpServers": {
    "lumen": {
      "command": "node",
      "args": ["/path/to/lumen-md/mcp-server/dist/index.js"],
      "env": { "LUMEN_WORKSPACE": "/Users/you/Documents/Lumen" }
    }
  }
}
```

Restart Claude Desktop. A 🔌 icon in the chat input confirms the server is
attached.

## Tools exposed

| Tool                  | Args                          | What it does                                                                                                                |
| --------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `read_note`           | `path`                        | Return the markdown body of a single note.                                                                                  |
| `write_note`          | `path`, `content`             | Create or overwrite a note (mkdir-p).                                                                                       |
| `list_notes`          | —                             | Recursively list every `.md` / `.txt` path.                                                                                 |
| `search_workspace`    | `query`, `limit?`             | Case-insensitive substring search.                                                                                          |
| `delete_note`         | `path`, `confirm: true`       | Delete a note. Refuses without `confirm: true` so the agent can't accidentally drop work.                                   |
| `update_frontmatter`  | `path`, `set?`, `unset?`      | Patch YAML-frontmatter keys without rewriting the body. `set` merges keys in; `unset` removes by name.                      |
| `list_tags`           | —                             | Aggregate every `tags:` value across the workspace into a tag → count map (newest tags ranked first).                       |
| `get_backlinks`       | `path`                        | Return every note containing a `[[wiki-link]]` to the given note (matched by basename without extension).                   |

### Example agent prompts

- "Read the latest note tagged `book` and summarise it." → `list_tags` → `search_workspace` → `read_note`
- "Add `status: archived` to every note under `2024/`." → `list_notes` → loop `update_frontmatter`
- "Which notes link to `Project Aurora`?" → `get_backlinks`

## Security boundary

The server refuses any path containing `..` or that is absolute, so an agent
cannot escape `LUMEN_WORKSPACE` to read the rest of your filesystem. Run the
server only against directories you'd be comfortable showing the agent.

## Sync with the Lumen web app

The web app stores files in OPFS (Origin-Private File System), which the
Node MCP process can't reach. To bridge the gap, point your Lumen workspace
at a Git repo (`⌘K → Git: Clone …`) and clone that same repo to the path
you set in `LUMEN_WORKSPACE`. Lumen's commit/pull commands keep the two
sides in sync, and the MCP server reads from the local clone.

## Dev

```bash
npm install
npm run build
LUMEN_WORKSPACE=/tmp/test-vault npm start
```

Talk to it via stdio (the MCP `Inspector` tool from
`@modelcontextprotocol/inspector` is the easiest dev loop).
