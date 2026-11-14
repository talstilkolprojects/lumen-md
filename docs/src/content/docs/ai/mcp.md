---
title: MCP and the lumen CLI
description: Let Claude Desktop, Claude Code or your IDE search and read your vault — off by default, with scopes per client, and every change waits for your approval.
---

Lumen's vault can be used from outside the app in two ways:

- the **MCP server** (`@lumen-md/mcp-server`) for AI clients that speak the
  [Model Context Protocol](https://modelcontextprotocol.io/) — Claude
  Desktop, Claude Code, Cursor, VS Code, Zed;
- the **`lumen` CLI** for you at a terminal: `lumen search`, `open`, `new`,
  `append`, `daily`.

Both work on the vault folder on disk. Three rules hold everywhere:

1. **Off by default.** A client gets no tools until you enable it.
2. **Scopes per client.** You choose what each client may do.
3. **No write without approval.** A client's write is only a proposal; the
   note changes when you approve it.

## Install

The server is not published to npm yet, so build it from the repository (Node 22+):

```bash
git clone https://github.com/talstilkol/lumen-md
cd lumen-md/mcp-server
npm ci
npm run build          # → mcp-server/dist/index.js and dist/lumen.js
```

Until it is on npm, run `node /path/to/lumen-md/mcp-server/dist/lumen.js`
where this page says `npx -p @lumen-md/mcp-server lumen`, and use
`"command": "node", "args": ["/path/to/lumen-md/mcp-server/dist/index.js", "--client", "…"]`
where a client config says `npx -y @lumen-md/mcp-server`.

## Turn a client on

```bash
cd ~/Documents/Lumen            # your vault folder
npx -p @lumen-md/mcp-server lumen mcp enable claude-desktop --scopes search,read
npx -p @lumen-md/mcp-server lumen mcp status
```

| Scope | Tools |
|---|---|
| `search` | `search_notes` — BM25 over Hebrew and English (prefix letters ו ה ב ל מ ש כ and niqqud are handled) |
| `read` | `read_note`, `list_notes`, `list_tags`, `get_backlinks` |
| `propose` | `create_note`, `append_note`, `write_note`, `update_frontmatter` — proposals only |

`lumen mcp enable <client>` without `--scopes` grants `search,read`. Add
`propose` only for a client you want suggestions from. `lumen mcp disable
<client>` takes effect on its next call. The settings live in
`<vault>/.lumen/mcp.json`; clients cannot read or write anything under
`.lumen/` (or any other dot folder), `..` or absolute paths.

## Connect it

Give each client its own `--client` name — the one you enabled. (Without
it, the server uses the name the client reports when it connects.)

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS; `%APPDATA%\Claude\` on Windows):

```json
{
  "mcpServers": {
    "lumen": {
      "command": "npx",
      "args": ["-y", "@lumen-md/mcp-server", "--client", "claude-desktop"],
      "env": { "LUMEN_VAULT": "/Users/you/Documents/Lumen" }
    }
  }
}
```

**Claude Code** — from any folder:

```bash
claude mcp add lumen -e LUMEN_VAULT="$HOME/Documents/Lumen" -- npx -y @lumen-md/mcp-server --client claude-code
npx -p @lumen-md/mcp-server lumen mcp enable claude-code --vault "$HOME/Documents/Lumen" --scopes search,read
```

**Cursor** (`~/.cursor/mcp.json`), **VS Code** (`.vscode/mcp.json`, key
`servers`) and **Zed** (`context_servers`) take the same command and
arguments: `npx -y @lumen-md/mcp-server --client cursor` (or `vscode`,
`zed`) with `LUMEN_VAULT` in `env`.

## Approving changes

A client's `create_note` / `append_note` / `write_note` /
`update_frontmatter` writes a proposal to `.lumen/mcp/pending/` and tells
the client nothing is written yet. You decide:

- **In Lumen:** the proposals appear in the review screen
  (⌘K → *AI: Review changes proposed by agents*, or the **Review** badge in
  the status bar) as "Proposed by claude-desktop (MCP client)", each as a
  diff. Approve writes the note; Reject drops it. This needs the vault
  folder in the app — the same folder, or synced with Git (`.lumen/` is
  synced like the notes).
- **In a terminal:**

  ```bash
  lumen mcp review              # every proposal as a diff
  lumen mcp approve <id>        # or --all
  lumen mcp reject <id>         # or --all
  ```

A proposal keeps the text it was computed from. If the note changed since,
approving writes nothing and the proposal is dropped as a conflict.

## The ledger

Every call — allowed, refused, proposed, approved, rejected — is a line in
`.lumen/mcp/ledger.jsonl`: time, client, tool, scope, note path, decision,
and how many bytes of your vault went to the client. Never the note text
or the query. `lumen mcp log` prints it.

## The `lumen` CLI

```bash
lumen search budget meeting      # path, title, matching line (exit 3: nothing found)
lumen open "Launch plan"         # opens it in your default app; --print to print it
lumen new ideas/one "first line" # creates; refuses if it exists
lumen append ideas/one.md "more"
lumen daily "call Dana"          # journal/YYYY-MM-DD.md, adds "- 09:05 call Dana"
```

The vault is `--vault <dir>`, else `$LUMEN_VAULT`, else the current folder.
`new`, `append` and `daily` are you at the keyboard, so they write directly
(logged as client `cli`). Install with `npm i -g @lumen-md/mcp-server`, or
run from a clone with `npm run lumen -- search …`.

## Speed

Search keeps an index in memory, built on the first search and brought up
to date before each one (only changed notes are read again). On 10,000
notes a search answers in well under 300 ms.
