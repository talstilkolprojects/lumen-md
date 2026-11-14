/**
 * Fetch → snapshot → block (plan W7.6), with the storage and the fetch
 * passed in, so the whole path runs in tests against recorded answers.
 */
import { fetchSeries, fetchTable, showDataset, type DatasetHit, type Table } from "./api";
import { diffSnapshots, insertion, parseBlock, personalColumns, renderBlock, sha256Hex, snapshotPath, toCsv, type DatasetBlock, type SnapshotDiff } from "./snapshot";

export interface FileStore {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
}

export interface Imported {
  block: DatasetBlock;
  /** The block and the attribution line, ready for the note. */
  markdown: string;
  rows: number;
  /** Columns that look personal (the warning). */
  personal: string[];
}

const today = () => new Date().toISOString().slice(0, 10);

async function keep(table: Table, block: Omit<DatasetBlock, "snapshot">, store: FileStore): Promise<Imported> {
  const snapshot = snapshotPath(block.source, block.id, block.retrieved);
  const csv = toCsv(table);
  await store.write(snapshot, csv);
  const full: DatasetBlock = { ...block, snapshot, sha256: await sha256Hex(csv) };
  return { block: full, markdown: insertion(full), rows: table.rows.length, personal: personalColumns(table.fields.map((f) => f.id)) };
}

/** A data.gov.il resource: its dataset's details, then its rows; both saved locally. */
export async function importResource(hit: Pick<DatasetHit, "name">, resourceId: string, deps: { fetch: typeof fetch; store: FileStore; retrieved?: string; limit?: number }): Promise<Imported> {
  const meta = await showDataset(hit.name, deps.fetch);
  const table = await fetchTable(resourceId, deps.fetch, deps.limit);
  const res = meta.resources.find((r) => r.id === resourceId);
  const title = res && res.name !== meta.title && res.name !== res.id ? `${meta.title} — ${res.name}` : meta.title;
  return keep(table, { source: "datagov", id: resourceId, title, dataset: meta.name, organization: meta.organization, updated: meta.modified, retrieved: deps.retrieved ?? today(), view: "table" }, deps.store);
}

/** A CBS series. */
export async function importSeries(id: string, deps: { fetch: typeof fetch; store: FileStore; retrieved?: string }): Promise<Imported> {
  const s = await fetchSeries(id, deps.fetch);
  return keep(s.table, { source: "cbs", id, title: s.name, retrieved: deps.retrieved ?? today(), view: "chart" }, deps.store);
}

export interface Refreshed {
  before: DatasetBlock;
  after: Imported;
  diff: SnapshotDiff;
  header: string[];
}

/** Fetch again into a new snapshot (the old file stays) and compare. */
export async function refreshBlock(blockBody: string, deps: { fetch: typeof fetch; store: FileStore; retrieved?: string }): Promise<Refreshed | null> {
  const before = parseBlock(blockBody);
  if (!before) return null;
  const old = (await deps.store.read(before.snapshot)) ?? "";
  const after = before.source === "cbs" ? await importSeries(before.id, deps) : await importResource({ name: before.dataset ?? "" }, before.id, deps);
  after.block.view = before.view;
  after.markdown = insertion(after.block);
  const fresh = (await deps.store.read(after.block.snapshot)) ?? "";
  const header = fresh.split("\n")[0]?.split(",") ?? [];
  return { before, after, diff: diffSnapshots(old, fresh), header };
}

/** The block's text with a new snapshot and date (for replacing it in the note). */
export const blockText = (b: DatasetBlock) => renderBlock(b);
