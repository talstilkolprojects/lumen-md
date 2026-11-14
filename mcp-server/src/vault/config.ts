/**
 * Who may use the vault from outside (plan W2.3): `<vault>/.lumen/mcp.json`.
 *
 * Off by default — with no file, or a client that is not in it, every tool
 * is refused and `tools/list` is empty. Each client is enabled explicitly
 * (`lumen mcp enable claude-desktop --scopes search,read`) with the scopes
 * it gets:
 *   search   search_notes
 *   read     read_note, list_notes, list_tags, get_backlinks
 *   propose  create_note, append_note, write_note, update_frontmatter —
 *            which never write: they add a change to the approval queue.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

export type McpScope = "search" | "read" | "propose";
export const ALL_SCOPES: readonly McpScope[] = ["search", "read", "propose"];
/** What `lumen mcp enable` grants when no `--scopes` is given: nothing that proposes changes. */
export const DEFAULT_SCOPES: readonly McpScope[] = ["search", "read"];

export interface ClientGrant {
  enabled: boolean;
  scopes: McpScope[];
  /** ISO time the client was last enabled. */
  since: string;
}

export interface McpConfig {
  version: 1;
  clients: Record<string, ClientGrant>;
}

export function lumenDir(vault: string): string {
  return path.join(vault, ".lumen");
}

export function configPath(vault: string): string {
  return path.join(lumenDir(vault), "mcp.json");
}

/** `Claude Desktop` → `claude-desktop`; empty → `unknown`. */
export function normalizeClientId(raw: string | undefined | null): string {
  const id = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return id || "unknown";
}

export function isScope(s: unknown): s is McpScope {
  return typeof s === "string" && (ALL_SCOPES as readonly string[]).includes(s);
}

/** `"search,read"` → scopes; throws on an unknown one. */
export function parseScopes(list: string): McpScope[] {
  const out: McpScope[] = [];
  for (const part of list.split(/[\s,]+/).filter(Boolean)) {
    if (!isScope(part)) throw new Error(`Unknown scope '${part}'. Scopes: ${ALL_SCOPES.join(", ")}.`);
    if (!out.includes(part)) out.push(part);
  }
  return out;
}

export function emptyConfig(): McpConfig {
  return { version: 1, clients: {} };
}

/** The config on disk; a missing or unreadable file is the default (nobody enabled). */
export async function readConfig(vault: string): Promise<McpConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath(vault), "utf8");
  } catch {
    return emptyConfig();
  }
  try {
    const parsed = JSON.parse(raw) as { clients?: Record<string, Partial<ClientGrant>> };
    const cfg = emptyConfig();
    for (const [id, g] of Object.entries(parsed.clients ?? {})) {
      if (!g || typeof g !== "object") continue;
      cfg.clients[normalizeClientId(id)] = {
        enabled: g.enabled === true,
        scopes: Array.isArray(g.scopes) ? g.scopes.filter(isScope) : [],
        since: typeof g.since === "string" ? g.since : "",
      };
    }
    return cfg;
  } catch {
    return emptyConfig();
  }
}

/** Write through a temporary file and a rename, so a reader never sees half a file. */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, file);
}

export async function writeConfig(vault: string, cfg: McpConfig): Promise<void> {
  await writeFileAtomic(configPath(vault), JSON.stringify(cfg, null, 2) + "\n");
}

export async function enableClient(vault: string, client: string, scopes: readonly McpScope[] = DEFAULT_SCOPES, now = new Date()): Promise<ClientGrant> {
  const cfg = await readConfig(vault);
  const grant: ClientGrant = { enabled: true, scopes: [...scopes], since: now.toISOString() };
  cfg.clients[normalizeClientId(client)] = grant;
  await writeConfig(vault, cfg);
  return grant;
}

export async function disableClient(vault: string, client: string): Promise<boolean> {
  const cfg = await readConfig(vault);
  const id = normalizeClientId(client);
  const g = cfg.clients[id];
  if (!g) return false;
  cfg.clients[id] = { ...g, enabled: false };
  await writeConfig(vault, cfg);
  return true;
}

/** The scopes an enabled client has, or null when it is not enabled. */
export function grantFor(cfg: McpConfig, client: string): McpScope[] | null {
  const g = cfg.clients[normalizeClientId(client)];
  return g && g.enabled ? g.scopes : null;
}
