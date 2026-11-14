/**
 * The app side of government data (plan W7.6): the vault as the snapshot
 * store and the gated, ledgered fetch. Loaded on first use, so none of it is
 * in the startup bundle.
 */
import "./strings";
import { isOPFSAvailable, readWorkspaceFile, workspaceHasFile, writeWorkspaceFile } from "../../storage/workspace";
import { isSourceEnabled, withGate } from "../open/gate";
import { searchDatasets, type DatasetHit } from "./api";
import { importResource, importSeries, refreshBlock, type FileStore, type Imported, type Refreshed } from "./core";

import { verifiedSnapshot, type DatasetBlock } from "./snapshot";

export { diffSummary } from "./snapshot";

export const LEDGER_REASON = "Government data (data.gov.il, CBS): the search words or dataset id only";

const vault: FileStore = {
  async read(path) {
    if (!isOPFSAvailable()) return null;
    try {
      return (await workspaceHasFile(path)) ? await readWorkspaceFile(path) : null;
    } catch {
      return null;
    }
  },
  write: (path, content) => writeWorkspaceFile(path, content),
};

const gate = (confirm: () => Promise<boolean>) => ({ source: "datagov", reason: LEDGER_REASON, confirm, enabled: () => isSourceEnabled("datagov") });
const changed = () => window.dispatchEvent(new Event("lumen-workspace-changed"));

export function search(q: string, confirm: () => Promise<boolean>): Promise<DatasetHit[] | null> {
  return withGate(gate(confirm), (f) => searchDatasets(q, f));
}

export async function addResource(hit: DatasetHit, resourceId: string, confirm: () => Promise<boolean>): Promise<Imported | null> {
  const r = await withGate(gate(confirm), (f) => importResource(hit, resourceId, { fetch: f, store: vault }));
  if (r) changed();
  return r;
}

export async function addSeries(id: string, confirm: () => Promise<boolean>): Promise<Imported | null> {
  const r = await withGate(gate(confirm), (f) => importSeries(id, { fetch: f, store: vault }));
  if (r) changed();
  return r;
}

export async function refresh(blockBody: string, confirm: () => Promise<boolean>): Promise<Refreshed | null> {
  const r = await withGate(gate(confirm), (f) => refreshBlock(blockBody, { fetch: f, store: vault }));
  if (r) changed();
  return r;
}

/** The snapshot the block shows: read from the vault, never fetched, and only the file the block wrote (its hash). */
export const readSnapshot = (block: DatasetBlock) => verifiedSnapshot(block, (p) => vault.read(p));
