/**
 * The MCP server over stdio (plan W2.3), wired to the SDK. Kept apart from
 * `index.ts` (which connects at import time) so the CLI's `lumen mcp serve`
 * starts the same server.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { normalizeClientId } from "./vault/config.js";
import { VaultIndex } from "./vault/search.js";
import { callTool, listToolsFor } from "./vault/tools.js";

export const SERVER_VERSION = "0.2.0";

/**
 * The client a call is attributed to: `--client <id>` / `LUMEN_MCP_CLIENT`
 * when the user's config names one (recommended — a client cannot pick it
 * itself), else the name the client reports when it connects.
 */
export function clientIdFor(explicit: string | undefined, reported: string | undefined): string {
  return normalizeClientId(explicit || reported || "unknown");
}

export async function serveStdio(vault: string, explicitClient?: string): Promise<void> {
  const index = new VaultIndex(vault, { minRefreshMs: 1000 });
  const server = new Server({ name: "lumen-mcp", version: SERVER_VERSION }, { capabilities: { tools: {} } });
  const client = () => clientIdFor(explicitClient, server.getClientVersion()?.name);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await listToolsFor(vault, client())).map((t) => ({ name: t.name, description: `${t.description} (scope: ${t.scope})`, inputSchema: t.inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const res = await callTool({ vault, client: client(), index }, req.params.name, req.params.arguments ?? {});
    return { content: res.content, ...(res.isError ? { isError: true } : {}) };
  });

  await server.connect(new StdioServerTransport());
  // stdout is reserved for MCP framing — log to stderr instead.
  process.stderr.write(`lumen-mcp ${SERVER_VERSION}: vault ${vault}; tools per .lumen/mcp.json (off until enabled)\n`);
}
