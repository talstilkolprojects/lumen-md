/**
 * Changes from MCP clients in the review screen (plan W2.3).
 *
 * The vault's MCP server (mcp-server/) never writes a note: a client's
 * write tool adds a proposal to `.lumen/mcp/pending/<id>.json`. When that
 * folder is in this workspace (the vault folder the server runs on, or a
 * synced copy of it), this module stages each proposal as an agent file
 * change (staging.ts), so it waits in the same review panel (plan 5.11) as
 * the app's own agents: nothing is written until the user approves it, and
 * approving writes only if the note still has the text the client saw.
 *
 * Once the user decides, the proposal file is removed and the decision is
 * added to `.lumen/mcp/ledger.jsonl` — the ledger the server and the CLI
 * write (`lumen mcp log`), without any note text.
 *
 * Loaded with the review bridge after startup; nothing here is in the
 * startup bundle.
 */
import { onStagedChanges, stageChange } from "./staging";
import type { StagedChange } from "./types";

export const MCP_PENDING_DIR = ".lumen/mcp/pending";
export const MCP_LEDGER = ".lumen/mcp/ledger.jsonl";
/** The agent id a proposal is staged under: `mcp:<client>`. */
export const MCP_AGENT_PREFIX = "mcp:";

export interface McpProposal {
  id: string;
  client: string;
  tool: string;
  path: string;
  before: string | null;
  after: string;
  createdAt: string;
}

/** The workspace functions this module uses (storage/workspace.ts). */
export interface InboxWorkspace {
  listWorkspaceFolder(path: string): Promise<string[]>;
  readWorkspaceFile(path: string): Promise<string>;
  writeWorkspaceFile(path: string, content: string): Promise<unknown>;
  deleteWorkspaceFile(path: string): Promise<void>;
  workspaceHasFile(path: string): Promise<boolean>;
}

const ID_RE = /^[a-z0-9]{6,40}$/;

/** A note path a proposal may target: relative, inside the vault, not in a dot folder. */
export function isSafeNotePath(p: string): boolean {
  if (!p || p.startsWith("/") || p.includes("\\") || /^[a-zA-Z]:/.test(p)) return false;
  const parts = p.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== ".." && !part.startsWith(".")) && /\.(md|markdown|txt)$/i.test(p);
}

/** The proposal in a pending file, or null when it is not a valid one. */
export function parseProposal(name: string, text: string): McpProposal | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  if (typeof p.id !== "string" || !ID_RE.test(p.id) || name !== `${p.id}.json`) return null;
  if (typeof p.client !== "string" || typeof p.tool !== "string" || typeof p.path !== "string" || typeof p.after !== "string" || typeof p.createdAt !== "string") return null;
  if (!(p.before === null || typeof p.before === "string")) return null;
  if (!isSafeNotePath(p.path)) return null;
  return { id: p.id, client: p.client.slice(0, 64), tool: p.tool.slice(0, 64), path: p.path, before: p.before, after: p.after, createdAt: p.createdAt };
}

type Decision = "approved" | "rejected" | "conflict";

export interface McpInbox {
  /** Read the pending folder and stage what is new; resolves to how many were staged. */
  sync(): Promise<number>;
  stop(): void;
}

/**
 * Watch the pending folder (now, every `intervalMs`, and when the window
 * gets focus) and settle the proposals the user decides on.
 */
export function createMcpInbox(ws: InboxWorkspace, opts: { intervalMs?: number; now?: () => Date } = {}): McpInbox {
  /** proposal id → staged change id */
  const staged = new Map<string, string>();
  const byChange = new Map<string, McpProposal>();
  const settled = new Set<string>();
  let syncing: Promise<number> | null = null;
  let stopped = false;
  const now = opts.now ?? (() => new Date());

  // One ledger write at a time: OPFS has no append, so each is read + write.
  let ledgerChain: Promise<void> = Promise.resolve();
  const appendLedger = (p: McpProposal, decision: Decision, reason?: string): Promise<void> => (ledgerChain = ledgerChain.then(() => writeLedger(p, decision, reason)).catch(() => {}));
  const writeLedger = async (p: McpProposal, decision: Decision, reason?: string) => {
    const line = JSON.stringify({ ts: now().toISOString(), client: p.client, tool: p.tool, path: p.path, decision, bytesOut: 0, id: p.id, reason: reason ? `app: ${reason}` : "app" });
    const prev = (await ws.workspaceHasFile(MCP_LEDGER)) ? await ws.readWorkspaceFile(MCP_LEDGER) : "";
    await ws.writeWorkspaceFile(MCP_LEDGER, prev + (prev && !prev.endsWith("\n") ? "\n" : "") + line + "\n");
  };

  const settle = async (change: StagedChange) => {
    const p = byChange.get(change.id);
    if (!p || settled.has(p.id)) return;
    const decision: Decision | null = change.status === "applied" ? "approved" : change.status === "rejected" ? "rejected" : change.status === "conflict" ? "conflict" : null;
    if (!decision) return;
    settled.add(p.id);
    try {
      await ws.deleteWorkspaceFile(`${MCP_PENDING_DIR}/${p.id}.json`);
    } catch {
      /* already gone (the CLI decided it too) */
    }
    await appendLedger(p, decision, change.conflict);
  };

  const off = onStagedChanges((list) => {
    for (const c of list) if (byChange.has(c.id) && c.status !== "pending") void settle(c);
  });

  const sync = async (): Promise<number> => {
    if (stopped) return 0;
    if (syncing) return syncing;
    syncing = (async () => {
      let n = 0;
      for (const name of await ws.listWorkspaceFolder(MCP_PENDING_DIR)) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -5);
        if (staged.has(id) || settled.has(id)) continue;
        let text: string;
        try {
          text = await ws.readWorkspaceFile(`${MCP_PENDING_DIR}/${name}`);
        } catch {
          continue;
        }
        const p = parseProposal(name, text);
        if (!p) continue;
        const change = stageChange({ kind: "file", path: p.path, before: p.before, after: p.after, summary: `${p.tool} · ${p.path}` }, { tool: p.tool, runId: `mcp-${p.id}`, agentId: `${MCP_AGENT_PREFIX}${p.client}` });
        staged.set(p.id, change.id);
        byChange.set(change.id, p);
        n++;
      }
      return n;
    })().finally(() => {
      syncing = null;
    });
    return syncing;
  };

  const onFocus = () => void sync().catch(() => {});
  const timer = setInterval(onFocus, opts.intervalMs ?? 10_000);
  if (typeof window !== "undefined") window.addEventListener("focus", onFocus);
  return {
    sync,
    stop() {
      stopped = true;
      clearInterval(timer);
      if (typeof window !== "undefined") window.removeEventListener("focus", onFocus);
      off();
    },
  };
}

/** The review bridge's entry point: the inbox on the app's workspace. */
export async function startMcpInbox(): Promise<McpInbox> {
  const ws = await import("../storage/workspace");
  const inbox = createMcpInbox(ws);
  void inbox.sync().catch(() => {});
  return inbox;
}
