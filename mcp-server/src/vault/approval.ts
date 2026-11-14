/**
 * Waiting for the user's approval under the 2026-07-28 MCP spec (plan W7.17).
 *
 * A write tool queues a proposal (pending.ts). A modern client then gets an
 * `input_required` result (Multi Round-Trip Requests) whose `requestState`
 * names the proposal; it retries the same `tools/call` with that state and
 * learns the outcome — written, rejected, a conflict — or gets
 * `input_required` again while the proposal still waits.
 *
 * The state passes through the client, so it is attacker-controlled input
 * (spec, MRTR server requirement 4). It is HMAC-SHA256 signed with a key
 * that never leaves the vault (`.lumen/mcp/state.key`, mode 0600), and it
 * binds the principal (client id), the request (tool name and a digest of
 * its arguments) and a short expiry (requirement 5). Nothing in it can
 * approve anything: approval comes only from the user, in Lumen's review
 * screen or `lumen mcp approve`, and the outcome is read from the ledger.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lumenDir } from "./config.js";
import { readLedger } from "./ledger.js";
import { getPending } from "./pending.js";
import { readBatch } from "./bases.js";

/** How long a `requestState` is honoured. A later retry proposes again. */
export const STATE_TTL_MS = 60 * 60 * 1000;

export interface ApprovalState {
  v: 1;
  /** Proposal id (pending.ts). */
  pid: string;
  client: string;
  tool: string;
  /** sha256 of the canonical JSON of the call's arguments. */
  digest: string;
  /** Expiry, ms since the epoch. */
  exp: number;
}

export type ApprovalOutcome =
  | { status: "pending" }
  | { status: "approved"; path?: string }
  | { status: "rejected"; path?: string }
  | { status: "conflict"; path?: string; reason?: string }
  | { status: "unknown" }
  | { status: "batch"; written: string[]; rejected: string[]; conflicts: string[]; unknown: number };

export class StateError extends Error {}

function keyFile(vault: string): string {
  return path.join(lumenDir(vault), "mcp", "state.key");
}

const keys = new Map<string, Buffer>();

/** The vault's signing key, created on first use (0600). */
export async function stateKey(vault: string): Promise<Buffer> {
  const cached = keys.get(vault);
  if (cached) return cached;
  const file = keyFile(vault);
  let hex: string;
  try {
    hex = (await fs.readFile(file, "utf8")).trim();
  } catch {
    await fs.mkdir(path.dirname(file), { recursive: true });
    hex = randomBytes(32).toString("hex");
    try {
      await fs.writeFile(file, hex + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch {
      // Another process created it first: use theirs.
      hex = (await fs.readFile(file, "utf8")).trim();
    }
  }
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`Bad state key in ${file}.`);
  const key = Buffer.from(hex, "hex");
  keys.set(vault, key);
  return key;
}

/** Stable JSON (sorted keys) so the same arguments always give the same digest. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export function argsDigest(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args ?? {})).digest("base64url");
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

export async function signState(vault: string, s: Omit<ApprovalState, "v" | "exp">, now = Date.now()): Promise<string> {
  const body = b64(JSON.stringify({ v: 1, ...s, exp: now + STATE_TTL_MS } satisfies ApprovalState));
  const mac = createHmac("sha256", await stateKey(vault)).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/**
 * Check a `requestState` from a retry: signature, principal, request and
 * expiry. Throws StateError on any mismatch (the request then fails, and
 * nothing is written either way).
 */
export async function verifyState(vault: string, raw: unknown, expect: { client: string; tool: string; args: unknown }, now = Date.now()): Promise<ApprovalState> {
  if (typeof raw !== "string" || raw.length > 4096) throw new StateError("requestState is not one this server issued.");
  const dot = raw.indexOf(".");
  if (dot <= 0) throw new StateError("requestState is not one this server issued.");
  const body = raw.slice(0, dot);
  const mac = Buffer.from(raw.slice(dot + 1), "base64url");
  const want = createHmac("sha256", await stateKey(vault)).update(body).digest();
  if (mac.length !== want.length || !timingSafeEqual(mac, want)) throw new StateError("requestState failed verification.");
  let s: ApprovalState;
  try {
    s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ApprovalState;
  } catch {
    throw new StateError("requestState failed verification.");
  }
  if (s.v !== 1 || typeof s.pid !== "string") throw new StateError("requestState failed verification.");
  if (s.client !== expect.client) throw new StateError("requestState belongs to another client.");
  if (s.tool !== expect.tool || s.digest !== argsDigest(expect.args)) throw new StateError("requestState belongs to another request.");
  if (!(s.exp > now)) throw new StateError("requestState expired; call the tool again to propose the change again.");
  return s;
}

/** The state's `pid` for a batch of proposals (one Bases update, W8.1). */
export const BATCH_PREFIX = "batch:";

/**
 * Where a proposal stands: still queued, or what the user decided (from
 * the ledger). A batch is pending while any of its proposals is; then it
 * reports every note's outcome.
 */
export async function approvalOutcome(vault: string, pid: string): Promise<ApprovalOutcome> {
  if (pid.startsWith(BATCH_PREFIX)) {
    const batch = await readBatch(vault, pid.slice(BATCH_PREFIX.length));
    if (!batch) return { status: "unknown" };
    const out = { status: "batch" as const, written: [] as string[], rejected: [] as string[], conflicts: [] as string[], unknown: 0 };
    for (const id of batch.ids) {
      const o = await approvalOutcome(vault, id);
      if (o.status === "pending") return o;
      if (o.status === "approved") out.written.push(o.path ?? id);
      else if (o.status === "rejected") out.rejected.push(o.path ?? id);
      else if (o.status === "conflict") out.conflicts.push(o.path ?? id);
      else out.unknown++;
    }
    return out;
  }
  if (await getPending(vault, pid)) return { status: "pending" };
  const entries = await readLedger(vault, Number.MAX_SAFE_INTEGER);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.id !== pid) continue;
    if (e.decision === "approved") return { status: "approved", path: e.path };
    if (e.decision === "rejected") return { status: "rejected", path: e.path };
    if (e.decision === "conflict") return { status: "conflict", path: e.path, reason: e.reason };
  }
  return { status: "unknown" };
}
