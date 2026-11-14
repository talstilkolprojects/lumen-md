/**
 * The vault's MCP / CLI ledger (plan W2.3): `<vault>/.lumen/mcp/ledger.jsonl`,
 * one JSON line per call — who (client), what (tool, scope, path), the
 * decision, and how many bytes of the vault were handed to the client.
 * Like the app's privacy ledger it never stores note text, queries or
 * answers. `lumen mcp log` prints it; the app shows it in the review panel
 * import (agents/mcpInbox.ts).
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { lumenDir, type McpScope } from "./config.js";

export type McpDecision = "allowed" | "denied" | "proposed" | "approved" | "rejected" | "conflict" | "written";

export interface McpLedgerEntry {
  ts: string;
  client: string;
  tool: string;
  scope?: McpScope;
  path?: string;
  decision: McpDecision;
  /** Bytes of vault content returned to the client (0 for a refusal or a proposal). */
  bytesOut: number;
  /** Approval-queue id, for proposals and their outcome. */
  id?: string;
  reason?: string;
}

export function ledgerPath(vault: string): string {
  return path.join(lumenDir(vault), "mcp", "ledger.jsonl");
}

export async function appendLedger(vault: string, entry: Omit<McpLedgerEntry, "ts"> & { ts?: string }): Promise<McpLedgerEntry> {
  const full: McpLedgerEntry = { ts: entry.ts ?? new Date().toISOString(), ...entry };
  const file = ledgerPath(vault);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(full) + "\n", "utf8");
  return full;
}

/** The newest `limit` entries, oldest first; malformed lines are skipped. */
export async function readLedger(vault: string, limit = 200): Promise<McpLedgerEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(ledgerPath(vault), "utf8");
  } catch {
    return [];
  }
  const out: McpLedgerEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as McpLedgerEntry;
      if (e && typeof e.tool === "string" && typeof e.decision === "string") out.push(e);
    } catch {
      /* a torn last line */
    }
  }
  return out.slice(-limit);
}
