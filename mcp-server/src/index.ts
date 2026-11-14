#!/usr/bin/env node
/**
 * @lumen-md/mcp-server — the Lumen vault for MCP clients (Claude Desktop,
 * Claude Code, Cursor, VS Code …), with consent and permissions (plan W2.3).
 *
 *   • Off by default: a client gets no tools until the user enables it,
 *     with scopes, in `<vault>/.lumen/mcp.json` (`lumen mcp enable …`).
 *   • Scopes: search (search_notes), read (read_note, list_notes,
 *     list_tags, get_backlinks), propose (create_note, append_note,
 *     write_note, update_frontmatter).
 *   • Write tools never write: they queue a proposal that the user
 *     approves in Lumen's review screen or with `lumen mcp approve`.
 *   • Every call is in `<vault>/.lumen/mcp/ledger.jsonl` (no note text).
 *
 * Claude Desktop config:
 *   { "mcpServers": { "lumen": { "command": "npx",
 *       "args": ["-y", "@lumen-md/mcp-server", "--client", "claude-desktop"],
 *       "env": { "LUMEN_VAULT": "/Users/you/Documents/Lumen" } } } }
 */
import * as path from "node:path";
import { serveStdio } from "./server.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

const vault = path.resolve(flag("vault") ?? process.env.LUMEN_VAULT ?? process.env.LUMEN_WORKSPACE ?? path.join(process.cwd(), "lumen-workspace"));
await serveStdio(vault, flag("client") ?? process.env.LUMEN_MCP_CLIENT);
