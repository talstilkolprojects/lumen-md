/**
 * The outside MCP servers the local agents may use (plan W7.18), and what
 * each may do. Everything is off until the user adds and enables a server.
 *
 *   • Per server and per tool: "read" (runs without asking — only for tools
 *     the server marks read-only), "ask" (the user approves each call) or
 *     "block" (never offered to the model). A tool without a setting is
 *     "ask"; a tool the server does not mark read-only is never "read".
 *   • Remote servers (Streamable HTTP to another machine) are network
 *     access: blocked in airplane mode (W5.9) and under the local-only AI
 *     policy, and each call goes through the runtime's network gate (the
 *     privacy ledger lists it). Local servers (stdio on the desktop, a
 *     loopback address) are not.
 *   • What a server returns is outside content: it passes the injection
 *     guard (2.7) before it reaches the model, and taints the run, so a
 *     write or network call after it needs the user's approval.
 */

export type ToolPermission = "read" | "ask" | "block";

export interface McpServerConfig {
  id: string;
  label: string;
  /** "http": Streamable HTTP at `url`; "stdio": a local command (desktop app only). */
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  enabled: boolean;
  /** Default for this server's tools (never "read" for a tool not marked read-only). */
  defaultPermission: ToolPermission;
  tools: Record<string, ToolPermission>;
  /** OAuth issuer the credentials were issued by (oauth.ts keys them by it). */
  issuer?: string;
  /** stdio only: the user says this program makes no network requests. Otherwise it counts as remote (airplane mode, local-only). */
  offline?: boolean;
  /** stdio only: the folder the command runs in (never the app's). */
  cwd?: string;
  /** Give the model the server's own tool descriptions (cleaned, capped). Off: names and parameters only. */
  trustDescriptions?: boolean;
  /**
   * A server Lumen implements itself (no MCP connection): Sefaria (W11.H17,
   * mcp/sefariaTools.ts). The same screen, permissions and airplane rules apply.
   */
  builtin?: boolean;
}

/** Suggested servers: off by default; the user adds one, then enables it. */
export const SUGGESTED_SERVERS: readonly Omit<McpServerConfig, "enabled" | "tools">[] = [
  {
    // It calls the Knesset's API: remote (blocked in airplane mode). Set `cwd` to your Knessy checkout.
    id: "knesset",
    label: "Knesset (Knessy — bills, votes, committee protocols; MIT)",
    transport: "stdio",
    command: "python3",
    args: ["-I", "-m", "mcp_server.server"],
    defaultPermission: "ask",
  },
  { id: "data-gov-il", label: "data.gov.il (Israeli government open data)", transport: "http", url: "", defaultPermission: "ask" },
  // W11.H17: built in (the four tools of Sivan22/mcp-sefaria-server, MIT, rewritten in TypeScript); remote: off in airplane mode.
  {
    id: "sefaria",
    label: "Sefaria (Jewish texts: get_text, get_commentaries, search_texts, get_daily_learnings; tools ported from Sivan22/mcp-sefaria-server, MIT)",
    transport: "http",
    url: "https://www.sefaria.org",
    builtin: true,
    defaultPermission: "ask",
  },
  { id: "zotero", label: "Zotero (your library, on this computer)", transport: "http", url: "http://127.0.0.1:23119/mcp", defaultPermission: "ask" },
  // Installed by the user (`npm i -g @modelcontextprotocol/server-filesystem@<version>`): Lumen never downloads and runs a package.
  { id: "files", label: "Your files (the reference filesystem server)", transport: "stdio", command: "mcp-server-filesystem", args: [], defaultPermission: "ask" },
];

export const STORE_KEY = "lumen.mcp.servers";

type Store = Pick<Storage, "getItem" | "setItem">;
const ls = (): Store | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export function readServers(store: Store | null = ls()): McpServerConfig[] {
  try {
    const v = JSON.parse(store?.getItem(STORE_KEY) ?? "[]") as McpServerConfig[];
    return Array.isArray(v) ? v.filter((s) => s && typeof s.id === "string" && (s.transport === "http" || s.transport === "stdio")) : [];
  } catch {
    return [];
  }
}

export function saveServers(list: McpServerConfig[], store: Store | null = ls()): void {
  try {
    store?.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    // why: storage is blocked or full (private mode, quota): the setting holds for this session only
    /* storage blocked: the change lasts for this session only */
  }
}

/** Add a suggested server (disabled) or a custom one. */
export function addServer(cfg: Omit<McpServerConfig, "enabled" | "tools"> & Partial<Pick<McpServerConfig, "enabled" | "tools">>, store: Store | null = ls()): McpServerConfig {
  const full: McpServerConfig = { enabled: false, tools: {}, ...cfg };
  saveServers([...readServers(store).filter((s) => s.id !== full.id), full], store);
  return full;
}

export function setToolPermission(serverId: string, tool: string, p: ToolPermission, store: Store | null = ls()): void {
  saveServers(
    readServers(store).map((s) => (s.id === serverId ? { ...s, tools: { ...s.tools, [tool]: p } } : s)),
    store,
  );
}

/** The permission a tool really has: "read" only for tools the server marks read-only. */
export function effectivePermission(server: McpServerConfig, tool: { name: string; annotations?: { readOnlyHint?: boolean } }): ToolPermission {
  const p = server.tools[tool.name] ?? server.defaultPermission ?? "ask";
  if (p === "read" && tool.annotations?.readOnlyHint !== true) return "ask";
  return p;
}

export interface ReachContext {
  airplane: boolean;
  /** The AI policy is local-only. */
  localOnly: boolean;
  /** Running in the desktop app (stdio servers need it). */
  desktop: boolean;
}

/** Why a server may not be used right now, or null when it may. */
export function blockedReason(server: McpServerConfig, reach: "local" | "remote", ctx: ReachContext): string | null {
  if (!server.enabled) return "off";
  if (server.transport === "stdio" && !ctx.desktop) return "stdio servers run only in the desktop app";
  // A local program may itself reach the network: it is remote unless the user marked it offline (review 21, C3).
  if (server.transport === "stdio" && !server.offline) reach = "remote";
  if (reach === "remote" && ctx.airplane) return "airplane mode: remote servers are blocked";
  if (reach === "remote" && ctx.localOnly) return "the AI policy is local-only: remote servers are blocked";
  return null;
}
