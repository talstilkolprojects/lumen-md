# @lumen-md/mcp-server

The Lumen vault for [Model Context Protocol](https://modelcontextprotocol.io/)
clients — Claude Desktop, Claude Code, Cursor, VS Code, Zed — and the
`lumen` command line (plan W2.3).

- **Off by default.** No client gets a tool until you run
  `lumen mcp enable <client> --scopes search,read[,propose]` in the vault.
- **Scopes per client:** `search` (search_notes), `read` (read_note,
  list_notes, list_tags, get_backlinks), `propose` (create_note,
  append_note, write_note, update_frontmatter).
- **No write without approval.** Write tools only add a proposal to
  `.lumen/mcp/pending/`; approve it in Lumen's review screen or with
  `lumen mcp review` / `approve <id>` / `reject <id>`.
- **Ledger.** Every call is a line in `.lumen/mcp/ledger.jsonl` (client,
  tool, path, decision, bytes sent) — never the note text. `lumen mcp log`.
- Clients cannot reach `..`, absolute paths, `.lumen/` or other dot folders.

## Install

The server is not published to npm yet, so build it from the repository (Node 22+):

```bash
git clone https://github.com/talstilkol/lumen-md
cd lumen-md/mcp-server
npm ci
npm run build          # → dist/index.js and dist/lumen.js
```

Until it is on npm, run `node /path/to/lumen-md/mcp-server/dist/lumen.js`
where these steps say `npx -p @lumen-md/mcp-server lumen`, and use
`"command": "node", "args": ["/path/to/lumen-md/mcp-server/dist/index.js", "--client", "…"]`
where a client config says `npx -y @lumen-md/mcp-server`.

## Connect

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

Claude Code: `claude mcp add lumen -e LUMEN_VAULT=$HOME/Documents/Lumen -- npx -y @lumen-md/mcp-server --client claude-code`.
The full guide (Cursor, VS Code, Zed, the CLI) is the docs page *MCP and the
lumen CLI* (`docs/src/content/docs/ai/mcp.md`).

## CLI

```
lumen search <words…> [--limit n] [--json]
lumen open <note> [--print]
lumen new <path> [text…]
lumen append <path> <text…>
lumen daily [text…] [--folder journal]
lumen mcp status | enable | disable | review | approve | reject | log | serve
```

## Develop

```bash
npm ci && npm run build
npm run test:stdio     # a real stdio session: off by default, 10,000-note search < 300 ms, writes wait for approval
```

The tool logic (`src/vault/`) is also tested from the app's vitest suite
(`src/__tests__/mcpVault.test.ts`).
