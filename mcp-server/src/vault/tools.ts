/**
 * The vault's MCP tools (plan W2.3), independent of the MCP SDK so tests
 * and the CLI drive exactly what a client gets.
 *
 * Every tool has a scope (config.ts). A call is checked against the
 * client's grant in `.lumen/mcp.json`, read again on every call so that
 * `lumen mcp disable` takes effect at once; a client that is not enabled
 * gets no tools and every call is refused. Write tools only propose
 * (pending.ts). Every call — allowed, refused or proposed — goes to the
 * ledger (ledger.ts).
 */
import { grantFor, normalizeClientId, readConfig, type McpScope } from "./config.js";
import { appendLedger } from "./ledger.js";
import { proposeWrite, readNote } from "./pending.js";
import { notePath, safeRel, VaultPathError } from "./paths.js";
import { VaultIndex } from "./search.js";
import { parseFrontmatter, serializeFrontmatter } from "../frontmatter.js";
import { BasesUnavailableError, planBasesUpdate, proposeBatch, queryVaultBase } from "./bases.js";

export interface ToolDef {
  name: string;
  scope: McpScope;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  /** Set when the call queued a proposal: its id in the approval queue (not sent to the client as such). */
  proposalId?: string;
  /** Set when the call queued several proposals at once (a Bases update): the batch id (bases.ts). */
  batchId?: string;
}

export interface ToolContext {
  vault: string;
  /** The client id (normalised); see `normalizeClientId`. */
  client: string;
  index: VaultIndex;
}

const str = (description?: string) => (description ? { type: "string", description } : { type: "string" });

export const TOOLS: readonly ToolDef[] = [
  {
    name: "search_notes",
    scope: "search",
    description: "Search the notes (BM25, Hebrew and English). Returns path, title and a matching line per note.",
    inputSchema: { type: "object", properties: { query: str("Words to find; every word must match."), limit: { type: "number", default: 20 } }, required: ["query"] },
  },
  {
    name: "read_note",
    scope: "read",
    description: "Read one note's Markdown.",
    inputSchema: { type: "object", properties: { path: str("Vault-relative path, e.g. 'projects/launch.md'") }, required: ["path"] },
  },
  { name: "list_notes", scope: "read", description: "List every note path in the vault.", inputSchema: { type: "object", properties: {} } },
  { name: "list_tags", scope: "read", description: "Every frontmatter tag with its note count.", inputSchema: { type: "object", properties: {} } },
  {
    name: "get_backlinks",
    scope: "read",
    description: "Notes that contain a [[wiki-link]] to the given note.",
    inputSchema: { type: "object", properties: { path: str() }, required: ["path"] },
  },
  {
    name: "create_note",
    scope: "propose",
    description: "Propose a new note. Nothing is written until the user approves it in Lumen or with `lumen mcp approve`.",
    inputSchema: { type: "object", properties: { path: str(), content: str("Markdown body.") }, required: ["path", "content"] },
  },
  {
    name: "append_note",
    scope: "propose",
    description: "Propose adding text to the end of a note (created if missing). Waits for the user's approval.",
    inputSchema: { type: "object", properties: { path: str(), content: str() }, required: ["path", "content"] },
  },
  {
    name: "write_note",
    scope: "propose",
    description: "Propose replacing a note's whole text. Waits for the user's approval.",
    inputSchema: { type: "object", properties: { path: str(), content: str() }, required: ["path", "content"] },
  },
  {
    name: "update_frontmatter",
    scope: "propose",
    description: "Propose setting or removing frontmatter keys of a note. Waits for the user's approval.",
    inputSchema: {
      type: "object",
      properties: { path: str(), set: { type: "object", description: "Keys to set." }, unset: { type: "array", items: { type: "string" } } },
      required: ["path"],
    },
  },
  {
    name: "bases_query",
    scope: "read",
    description: "Rows of a Lumen/Obsidian .base view, computed by Lumen's own Bases engine: the same rows the app shows. Returns JSON { view, columns, rows: [{ path, cells }], total, errors }.",
    inputSchema: {
      type: "object",
      properties: {
        base: str("Vault-relative path of the .base file, e.g. 'projects/tasks.base'"),
        view: { type: ["string", "number"], description: "View name or index (default: the first view)." },
        offset: { type: "number", default: 0 },
        limit: { type: "number", default: 200, description: "At most 10,000." },
      },
      required: ["base"],
    },
  },
  {
    name: "bases_update",
    scope: "propose",
    description: "Propose changing note properties (rows of a base): one proposal per changed note, in one batch. Nothing is written until the user approves it in Lumen or with `lumen mcp approve`.",
    inputSchema: {
      type: "object",
      properties: {
        edits: {
          type: "array",
          description: "At most 5,000 rows.",
          items: { type: "object", properties: { path: str("The note (.md)."), set: { type: "object", description: "property: value (text, number, true/false, null or a list of texts)." } }, required: ["path", "set"] },
        },
      },
      required: ["edits"],
    },
  },
];

/** Rows `bases_query` returns when the client does not say. */
export const BASES_DEFAULT_LIMIT = 200;

/** Old names from the first MCP server, still answered. */
const ALIASES: Record<string, string> = { search_workspace: "search_notes" };

export function toolDef(name: string): ToolDef | undefined {
  const real = ALIASES[name] ?? name;
  return TOOLS.find((t) => t.name === real);
}

/** The tools this client may call right now (empty when it is not enabled). */
export async function listToolsFor(vault: string, client: string): Promise<ToolDef[]> {
  const scopes = grantFor(await readConfig(vault), client);
  return scopes ? TOOLS.filter((t) => scopes.includes(t.scope)) : [];
}

const text = (t: string, isError = false): ToolResult => (isError ? { content: [{ type: "text", text: t }], isError: true } : { content: [{ type: "text", text: t }] });

export function enableHint(client: string, scope: McpScope): string {
  return `lumen mcp enable ${normalizeClientId(client)} --scopes ${scope === "search" ? "search" : scope === "read" ? "search,read" : "search,read,propose"}`;
}

export async function callTool(ctx: ToolContext, name: string, rawArgs: unknown): Promise<ToolResult> {
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const def = toolDef(name);
  const client = normalizeClientId(ctx.client);
  if (!def) return text(`Unknown tool: ${name}`, true);
  const scopes = grantFor(await readConfig(ctx.vault), client);
  if (!scopes || !scopes.includes(def.scope)) {
    const reason = scopes ? `scope '${def.scope}' not granted` : "client not enabled";
    await appendLedger(ctx.vault, { client, tool: def.name, scope: def.scope, decision: "denied", bytesOut: 0, reason });
    return text(
      scopes
        ? `Lumen: '${client}' may not use ${def.name} (needs the '${def.scope}' scope). The user can allow it with: ${enableHint(client, def.scope)}`
        : `Lumen: access from '${client}' is off. The user can turn it on with: ${enableHint(client, def.scope)}`,
      true,
    );
  }
  let target: string | undefined;
  try {
    const result = await run(ctx, client, def, args, (p) => (target = p));
    if (def.scope !== "propose") {
      const bytesOut = result.content.reduce((n, c) => n + Buffer.byteLength(c.text, "utf8"), 0);
      await appendLedger(ctx.vault, { client, tool: def.name, scope: def.scope, path: target, decision: "allowed", bytesOut: result.isError ? 0 : bytesOut });
    }
    return result;
  } catch (e) {
    const msg = e instanceof VaultPathError ? e.message : `Lumen: ${(e as Error)?.message ?? String(e)}`;
    await appendLedger(ctx.vault, { client, tool: def.name, scope: def.scope, path: target, decision: "denied", bytesOut: 0, reason: msg.slice(0, 200) });
    return text(msg, true);
  }
}

async function propose(ctx: ToolContext, client: string, tool: string, rel: string, before: string | null, after: string): Promise<ToolResult> {
  if (before === after) return text(`No change to ${rel}.`);
  const p = await proposeWrite(ctx.vault, { client, tool, path: rel, before, after });
  return { ...text(`Proposed ${before === null ? "a new note" : "a change to"} ${rel} (id ${p.id}). Nothing is written until the user approves it in Lumen (review screen) or with \`lumen mcp approve ${p.id}\`.`), proposalId: p.id };
}

async function run(ctx: ToolContext, client: string, def: ToolDef, args: Record<string, unknown>, onPath: (p: string) => void): Promise<ToolResult> {
  switch (def.name) {
    case "search_notes": {
      const query = String(args.query ?? "");
      if (!query.trim()) return text("Empty query.", true);
      const limit = Math.min(100, Math.max(1, Number(args.limit ?? 20) || 20));
      const hits = await ctx.index.search(query, limit);
      return text(hits.length ? hits.map((h) => `${h.path}\t${h.title}\t${h.snippet}`).join("\n") : `No notes match '${query}'.`);
    }
    case "read_note": {
      const rel = safeRel(String(args.path ?? ""));
      onPath(rel);
      const body = await readNote(ctx.vault, rel);
      return body === null ? text(`No note at ${rel}.`, true) : text(body);
    }
    case "list_notes": {
      await ctx.index.refresh();
      const all = ctx.index.paths();
      return text(all.join("\n") || "(empty vault)");
    }
    case "list_tags": {
      await ctx.index.refresh();
      const counts = new Map<string, number>();
      for (const rel of ctx.index.paths()) {
        const tags = parseFrontmatter(ctx.index.text(rel) ?? "").data.tags;
        const list = Array.isArray(tags) ? tags.map(String) : typeof tags === "string" ? tags.split(/[,\s]+/) : [];
        for (const raw of list) {
          const key = raw.replace(/^#/, "").toLowerCase();
          if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return text(sorted.length ? sorted.map(([t, c]) => `${t}\t${c}`).join("\n") : "(no tags found)");
    }
    case "get_backlinks": {
      const rel = safeRel(String(args.path ?? ""));
      onPath(rel);
      await ctx.index.refresh();
      const target = rel.split("/").pop()!.replace(/\.(md|markdown|txt)$/i, "");
      const re = new RegExp(`\\[\\[(?:[^\\]|#]*/)?${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\.md)?(?:[|#][^\\]]*)?\\]\\]`, "i");
      const hits = ctx.index.paths().filter((p) => p !== rel && re.test(ctx.index.text(p) ?? ""));
      return text(hits.length ? hits.join("\n") : `(no backlinks to ${target})`);
    }
    case "create_note": {
      const rel = notePath(String(args.path ?? ""));
      onPath(rel);
      const content = String(args.content ?? "");
      if ((await readNote(ctx.vault, rel)) !== null) return text(`${rel} already exists; use append_note or write_note.`, true);
      return propose(ctx, client, def.name, rel, null, content);
    }
    case "append_note": {
      const rel = notePath(String(args.path ?? ""));
      onPath(rel);
      const content = String(args.content ?? "");
      const before = await readNote(ctx.vault, rel);
      const after = before === null || before === "" ? content : before.endsWith("\n") ? before + content : `${before}\n${content}`;
      return propose(ctx, client, def.name, rel, before, after);
    }
    case "write_note": {
      const rel = notePath(String(args.path ?? ""));
      onPath(rel);
      return propose(ctx, client, def.name, rel, await readNote(ctx.vault, rel), String(args.content ?? ""));
    }
    case "update_frontmatter": {
      const rel = notePath(String(args.path ?? ""));
      onPath(rel);
      const before = await readNote(ctx.vault, rel);
      if (before === null) return text(`No note at ${rel}.`, true);
      const fm = parseFrontmatter(before);
      const data: Record<string, unknown> = { ...fm.data, ...((args.set && typeof args.set === "object" ? args.set : {}) as Record<string, unknown>) };
      for (const k of Array.isArray(args.unset) ? args.unset.map(String) : []) delete data[k];
      return propose(ctx, client, def.name, rel, before, serializeFrontmatter(data) + before.slice(fm.bodyStart));
    }
    case "bases_query": {
      const base = String(args.base ?? "");
      onPath(base);
      try {
        const r = await queryVaultBase(ctx.vault, base, args.view, { offset: args.offset, limit: args.limit ?? BASES_DEFAULT_LIMIT });
        return text(JSON.stringify(r));
      } catch (e) {
        if (e instanceof BasesUnavailableError || e instanceof VaultPathError) return text(e.message, true);
        return text(`Lumen: ${(e as Error)?.message ?? String(e)}`, true);
      }
    }
    case "bases_update": {
      let plan;
      try {
        plan = await planBasesUpdate(ctx.vault, args.edits);
      } catch (e) {
        if (e instanceof BasesUnavailableError || e instanceof VaultPathError) return text(e.message, true);
        return text(`Lumen: ${(e as Error)?.message ?? String(e)}`, true);
      }
      if (!plan.changes.length) return text(`No change: ${plan.summary.unchanged} row(s) already have these values.`);
      const batch = await proposeBatch(ctx.vault, client, def.name, plan.changes);
      onPath(plan.changes[0]!.path);
      const props = plan.summary.properties.join(", ");
      return {
        ...text(
          `Proposed changes to ${plan.changes.length} note(s) (${props}; batch ${batch.id}). Nothing is written until the user approves them in Lumen (review screen) or with \`lumen mcp approve --all\`.`,
        ),
        batchId: batch.id,
      };
    }
    default:
      return text(`Unknown tool: ${def.name}`, true);
  }
}
