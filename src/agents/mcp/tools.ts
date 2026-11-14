/**
 * An outside MCP server's tools as agent tools (plan W7.18), under the
 * runtime's rules (5.3) and the server's permissions (servers.ts):
 *
 *   • "block" tools are not offered; "ask" tools ask the user on each call
 *     (`confirmCall`); "read" tools (read-only ones only) run.
 *   • A remote server's tools have the "network" scope: the runtime's
 *     network gate decides (AI policy, consent, privacy ledger) and hands
 *     the call its fetch. A local server's tools have the "read" scope.
 *   • The answer is outside content: `untrusted` makes the runtime
 *     pass it through the injection guard and taint the run (2.7), so a
 *     later write or network call needs the user's approval.
 *   • Airplane mode is checked again on every call, not only when the
 *     tools were listed.
 */
import type { AgentTool, ToolContext } from "../types";
import { ToolError } from "../tools/define";
import { McpClient, type McpTool, type McpTransport } from "./client";
import { blockedReason, effectivePermission, type McpServerConfig, type ReachContext } from "./servers";

export interface BridgeOptions {
  reach: () => ReachContext;
  /** The user's answer for an "ask" tool call. */
  confirmCall: (server: McpServerConfig, tool: string, args: Record<string, unknown>) => boolean | Promise<boolean>;
}

/** Agent-tool names: `mcp__<server>__<tool>`, within the name rules small models and APIs accept. */
export function agentToolName(serverId: string, tool: string): string {
  return `mcp__${serverId}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

export const SOURCE_PREFIX = "MCP server ";

export async function serverAgentTools(server: McpServerConfig, makeTransport: (ctx?: ToolContext) => McpTransport, o: BridgeOptions): Promise<AgentTool[]> {
  const probe = makeTransport();
  const why = blockedReason(server, probe.reach, o.reach());
  if (why) return [];
  const listed: McpTool[] = await new McpClient(probe).listTools();
  const scope = probe.reach === "remote" ? "network" : "read";
  const out: AgentTool[] = [];
  for (const t of listed) {
    const perm = effectivePermission(server, t);
    if (perm === "block") continue;
    out.push({
      name: agentToolName(server.id, t.name),
      description: `${t.description ?? t.name} (from the MCP server "${server.label}"${perm === "ask" ? "; the user approves each call" : ""})`,
      parameters: (t.inputSchema as AgentTool["parameters"]) ?? { type: "object", properties: {} },
      scope,
      untrusted: () => [`${SOURCE_PREFIX}${server.label}`],
      async run(args: Record<string, unknown>, ctx: ToolContext) {
        const transport = makeTransport(ctx);
        const blocked = blockedReason(server, transport.reach, o.reach());
        if (blocked) throw new ToolError("denied", `MCP server "${server.label}": ${blocked}`);
        if (perm === "ask" && !(await o.confirmCall(server, t.name, args))) throw new ToolError("denied", `the user did not allow ${t.name} on "${server.label}"`);
        const r = await new McpClient(transport).callTool(t.name, args);
        if (r.kind === "input_required") throw new ToolError("denied", r.text);
        if (r.isError) throw new ToolError("failed", r.text.slice(0, 500) || `${t.name} failed`);
        return r.text;
      },
    });
  }
  return out;
}
