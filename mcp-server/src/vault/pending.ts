/**
 * The approval queue for changes from outside (plan W2.3).
 *
 * An MCP client never writes a note. Its write tools compute the new text
 * and add a proposal to `<vault>/.lumen/mcp/pending/<id>.json`; the note
 * changes only when the user approves it — in a terminal
 * (`lumen mcp review` / `lumen mcp approve <id>`) or in the app's review
 * screen (plan 5.11), which imports the queue (src/agents/mcpInbox.ts).
 *
 * The proposal keeps the text it was computed from (`before`, null for a
 * new note). Approving writes only when the note still has that text;
 * otherwise it is a conflict and nothing is written — the same rule as
 * the app's staged file changes (src/agents/staging.ts).
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { lumenDir, writeFileAtomic } from "./config.js";
import { appendLedger } from "./ledger.js";
import { realVaultPath, safeRel } from "./paths.js";

export interface PendingWrite {
  id: string;
  /** The MCP client (normalised id) that proposed it. */
  client: string;
  tool: string;
  /** Vault-relative note path. */
  path: string;
  /** The note's text the change was computed from; null: the note did not exist. */
  before: string | null;
  after: string;
  createdAt: string;
}

const ID_RE = /^[a-z0-9]{6,40}$/;

export function pendingDir(vault: string): string {
  return path.join(lumenDir(vault), "mcp", "pending");
}

/** The vault-relative folder the app reads (`.lumen/mcp/pending`). */
export const PENDING_REL = ".lumen/mcp/pending";

export function isPendingWrite(v: unknown): v is PendingWrite {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    ID_RE.test(p.id) &&
    typeof p.client === "string" &&
    typeof p.tool === "string" &&
    typeof p.path === "string" &&
    (p.before === null || typeof p.before === "string") &&
    typeof p.after === "string" &&
    typeof p.createdAt === "string"
  );
}

let seq = 0;
/** Time, then a per-process counter, then randomness: sorts in the order proposed. */
export function newProposalId(now: Date): string {
  seq = (seq + 1) % 36 ** 4;
  return now.getTime().toString(36).padStart(9, "0") + seq.toString(36).padStart(4, "0") + randomBytes(4).toString("hex");
}

function fileOf(vault: string, id: string): string {
  if (!ID_RE.test(id)) throw new Error(`Bad proposal id '${id}'.`);
  return path.join(pendingDir(vault), `${id}.json`);
}

/** The note's current text, or null when it does not exist. */
export async function readNote(vault: string, rel: string): Promise<string | null> {
  try {
    return await fs.readFile(await realVaultPath(vault, rel), "utf8"); // M1: never through a link out of the vault or into .lumen
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * How many proposals one client may have waiting (review 21, M4). The queue had
 * no bound, so a client with the propose scope could fill the disk and bury
 * the review screen. A Bases update across a whole base fits well inside it.
 */
export const MAX_PENDING_PER_CLIENT = 1000;

export class QueueFullError extends Error {}

/** Refuse when `client` would have more than `limit` proposals waiting with `adding` more. */
export async function checkQueueRoom(vault: string, client: string, adding = 1, limit = MAX_PENDING_PER_CLIENT): Promise<void> {
  const waiting = (await listPending(vault)).filter((q) => q.client === client).length;
  if (waiting + adding > limit) {
    throw new QueueFullError(`${waiting} changes from ${client} are already waiting for the user's review (at most ${limit}). Nothing was queued; ask the user to review or reject them first.`);
  }
}

/** Queue a change. Writes nothing to the note itself. */
export async function proposeWrite(vault: string, p: Omit<PendingWrite, "id" | "createdAt">, now = new Date(), limit = MAX_PENDING_PER_CLIENT): Promise<PendingWrite> {
  await checkQueueRoom(vault, p.client, 1, limit);
  const full: PendingWrite = { ...p, path: safeRel(p.path), id: newProposalId(now), createdAt: now.toISOString() };
  await writeFileAtomic(fileOf(vault, full.id), JSON.stringify(full, null, 2) + "\n");
  await appendLedger(vault, { client: full.client, tool: full.tool, scope: "propose", path: full.path, decision: "proposed", bytesOut: 0, id: full.id });
  return full;
}

/** The queue, oldest first. Files that are not proposals are skipped. */
export async function listPending(vault: string): Promise<PendingWrite[]> {
  let names: string[];
  try {
    names = await fs.readdir(pendingDir(vault));
  } catch {
    return [];
  }
  const out: PendingWrite[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const v = JSON.parse(await fs.readFile(path.join(pendingDir(vault), name), "utf8")) as unknown;
      if (isPendingWrite(v) && name === `${v.id}.json`) out.push(v);
    } catch {
      /* unreadable or half written */
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export async function getPending(vault: string, id: string): Promise<PendingWrite | null> {
  try {
    const v = JSON.parse(await fs.readFile(fileOf(vault, id), "utf8")) as unknown;
    return isPendingWrite(v) ? v : null;
  } catch {
    return null;
  }
}

export type ApproveResult = { status: "applied"; pending: PendingWrite } | { status: "conflict"; pending: PendingWrite; reason: string } | { status: "missing" };

/**
 * Approve: write the note if it still has the text the change was computed
 * from, then drop the proposal. A conflict keeps the note as it is and
 * drops the proposal too (the client can propose again from the new text).
 */
export async function approvePending(vault: string, id: string, by = "cli"): Promise<ApproveResult> {
  const p = await getPending(vault, id);
  if (!p) return { status: "missing" };
  const current = await readNote(vault, p.path);
  if (current !== p.before) {
    const reason = p.before === null ? "the note was created since" : current === null ? "the note was deleted since" : "the note changed since";
    await fs.rm(fileOf(vault, id), { force: true });
    await appendLedger(vault, { client: p.client, tool: p.tool, path: p.path, decision: "conflict", bytesOut: 0, id, reason: `${reason} (${by})` });
    return { status: "conflict", pending: p, reason };
  }
  await writeFileAtomic(await realVaultPath(vault, p.path), p.after); // M1: an approved write follows no link out of the vault
  await fs.rm(fileOf(vault, id), { force: true });
  await appendLedger(vault, { client: p.client, tool: p.tool, path: p.path, decision: "approved", bytesOut: 0, id, reason: by });
  return { status: "applied", pending: p };
}

export async function rejectPending(vault: string, id: string, by = "cli"): Promise<PendingWrite | null> {
  const p = await getPending(vault, id);
  if (!p) return null;
  await fs.rm(fileOf(vault, id), { force: true });
  await appendLedger(vault, { client: p.client, tool: p.tool, path: p.path, decision: "rejected", bytesOut: 0, id, reason: by });
  return p;
}

/** A short line diff for the terminal (`-` / `+` lines, unchanged lines left out beyond one of context). */
export function lineDiff(before: string | null, after: string, maxLines = 80): string[] {
  const a = before === null ? [] : before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: string[] = [];
  if (start > 0) out.push(`  ${a[start - 1]}`);
  for (const l of a.slice(start, endA)) out.push(`- ${l}`);
  for (const l of b.slice(start, endB)) out.push(`+ ${l}`);
  if (endA < a.length) out.push(`  ${a[endA]}`);
  return out.length > maxLines ? [...out.slice(0, maxLines), `… ${out.length - maxLines} more lines`] : out;
}
