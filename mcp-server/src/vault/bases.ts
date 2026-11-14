/**
 * Bases from outside the app (plan W8.1): `bases_query` and `bases_update`
 * for MCP clients, `lumen bases query|update` for the terminal.
 *
 * The rows come from the app's own engine (src/views/bases/api.ts, W6.46),
 * not a copy: `npm run build` bundles it into `dist/bases-engine.js`
 * (scripts/bundle-bases.mjs), and tests hand the source module in with
 * `setBasesEngine`. So a client sees exactly the rows the app shows.
 *
 * An update never writes. The engine computes the new text of every note
 * (its approval step answers "yes" only to collect the writes); each
 * changed note becomes a proposal in the same approval queue as every
 * other client write (pending.ts), all under one batch id. The user
 * approves or rejects them in Lumen's review screen or `lumen mcp approve`.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { lumenDir, writeFileAtomic } from "./config.js";
import { newProposalId, proposeWrite, readNote } from "./pending.js";
import { safeRel, VaultPathError } from "./paths.js";

export interface BasesQueryResult {
  view: string;
  columns: Array<{ id: string; label: string }>;
  rows: Array<{ path: string; cells: Record<string, unknown> }>;
  total: number;
  errors: string[];
}

export interface BasesUpdateSummary {
  notes: number;
  properties: string[];
  sample: string[];
  unchanged: number;
}

interface ReadDeps {
  paths(): Promise<string[]>;
  readText(path: string): Promise<string>;
  now?: Date;
}

/** The part of src/views/bases/api.ts this module uses. */
export interface BasesEngine {
  queryBase(deps: ReadDeps, basePath: string, view?: string | number, page?: { offset?: number; limit?: number }): Promise<BasesQueryResult>;
  updateRows(deps: ReadDeps & { write(path: string, text: string): Promise<void>; confirm(summary: BasesUpdateSummary): Promise<boolean> }, raw: unknown): Promise<{ written: number; unchanged: number; declined: boolean }>;
}

let engine: BasesEngine | null = null;

/** Tests (and anyone embedding the server) pass the engine in. */
export function setBasesEngine(e: BasesEngine | null): void {
  engine = e;
}

export class BasesUnavailableError extends Error {}

/** The engine: the injected one, else the bundle next to dist/. */
export async function basesEngine(): Promise<BasesEngine> {
  if (engine) return engine;
  const spec = new URL("../bases-engine.js", import.meta.url).href;
  try {
    engine = (await import(spec)) as BasesEngine;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ERR_MODULE_NOT_FOUND") throw e;
    throw new BasesUnavailableError("Bases are not in this build of the server (dist/bases-engine.js is missing). Build it with `npm run build` in mcp-server/ after `npm ci` in the repository root.");
  }
  return engine;
}

/** Every vault file the app lists for Bases: no dot folders, no `lumen-asset-` files (storage/workspace.ts). */
export async function vaultFiles(vault: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(rel ? path.join(vault, ...rel.split("/")) : vault, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && !e.name.startsWith("lumen-asset-")) out.push(p);
    }
  };
  await walk("");
  return out.sort();
}

export function readDeps(vault: string, now?: Date): ReadDeps {
  return {
    paths: () => vaultFiles(vault),
    readText: async (p) => {
      const t = await readNote(vault, safeRel(p));
      if (t === null) throw new VaultPathError(`No file at ${p}.`);
      return t;
    },
    ...(now ? { now } : {}),
  };
}

export function basePathOf(raw: unknown): string {
  const p = safeRel(String(raw ?? ""));
  if (!/\.base$/i.test(p)) throw new VaultPathError(`'${String(raw)}' is not a .base file.`);
  return p;
}

export async function queryVaultBase(vault: string, base: unknown, view?: unknown, page: { offset?: unknown; limit?: unknown } = {}, now?: Date): Promise<BasesQueryResult> {
  const e = await basesEngine();
  const v = typeof view === "number" || (typeof view === "string" && view !== "") ? view : undefined;
  const num = (x: unknown) => (x === undefined || x === null || x === "" ? undefined : Number(x));
  return e.queryBase(readDeps(vault, now), basePathOf(base), v, { offset: num(page.offset), limit: num(page.limit) });
}

export interface PlannedUpdate {
  summary: BasesUpdateSummary;
  changes: Array<{ path: string; before: string; after: string }>;
}

/** What an update would change, computed by the engine; nothing is written. */
export async function planBasesUpdate(vault: string, edits: unknown): Promise<PlannedUpdate> {
  const e = await basesEngine();
  const deps = readDeps(vault);
  const after = new Map<string, string>();
  let summary: BasesUpdateSummary = { notes: 0, properties: [], sample: [], unchanged: 0 };
  const r = await e.updateRows(
    {
      ...deps,
      write: async (p, text) => void after.set(safeRel(p), text),
      confirm: async (s) => {
        summary = s;
        return true; // collect the writes; the user approves them in the queue
      },
    },
    edits,
  );
  if (!r.written) summary = { ...summary, unchanged: r.unchanged };
  const changes: PlannedUpdate["changes"] = [];
  for (const [p, text] of after) changes.push({ path: p, before: await deps.readText(p), after: text });
  return { summary, changes };
}

export interface BatchRecord {
  id: string;
  client: string;
  tool: string;
  ids: string[];
  createdAt: string;
}

const BATCH_RE = /^[a-z0-9]{6,40}$/;

function batchFile(vault: string, id: string): string {
  if (!BATCH_RE.test(id)) throw new Error(`Bad batch id '${id}'.`);
  return path.join(lumenDir(vault), "mcp", "batches", `${id}.json`);
}

/** Queue every change as a proposal under one batch id. */
export async function proposeBatch(vault: string, client: string, tool: string, changes: PlannedUpdate["changes"], now = new Date()): Promise<BatchRecord> {
  const ids: string[] = [];
  for (const c of changes) {
    if ((await readNote(vault, c.path)) !== c.before) throw new Error(`${c.path} changed while the update was computed; try again.`);
    ids.push((await proposeWrite(vault, { client, tool, path: c.path, before: c.before, after: c.after }, now)).id);
  }
  const rec: BatchRecord = { id: newProposalId(now), client, tool, ids, createdAt: now.toISOString() };
  await writeFileAtomic(batchFile(vault, rec.id), JSON.stringify(rec, null, 2) + "\n");
  return rec;
}

export async function readBatch(vault: string, id: string): Promise<BatchRecord | null> {
  try {
    const v = JSON.parse(await fs.readFile(batchFile(vault, id), "utf8")) as BatchRecord;
    return v && v.id === id && Array.isArray(v.ids) && v.ids.every((x) => typeof x === "string") ? v : null;
  } catch {
    return null;
  }
}

/** For the CLI and tests: an absolute path is never a vault path. */
export function relForCli(vault: string, p: string): string {
  return path.isAbsolute(p) ? path.relative(vault, p).split(path.sep).join("/") : p;
}
