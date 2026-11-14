/**
 * Government data in a note (plan W7.6): data.gov.il and the Central Bureau
 * of Statistics (CBS, הלמ״ס).
 *
 *  - data.gov.il is a CKAN site: `package_search` finds datasets,
 *    `package_show` gives a dataset's title, publisher and update date, and
 *    `datastore_search` returns a resource's rows. No key is needed
 *    (CKAN Action API v3, /api/3/action/…).
 *  - CBS time series: `https://apis.cbs.gov.il/series/data/list?id=…&format=json&download=false`
 *    returns `DataSet.Series[].obs[] { TimePeriod, Value }`.
 *
 * What leaves the device: the search words, a resource id or a series id —
 * never the note. Requests are made only when the user asks, through the
 * gated, ledgered fetch (sources/open/gate).
 */

export const CKAN = "https://data.gov.il/api/3/action/";
export const CBS_SERIES = "https://apis.cbs.gov.il/series/data/list";

export class DataGovError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DataGovError";
  }
}

export interface DatasetHit {
  /** CKAN package name (slug). */
  name: string;
  title: string;
  organization: string | null;
  /** YYYY-MM-DD */
  modified: string | null;
  resources: Array<{ id: string; name: string; format: string; datastore: boolean }>;
}

export interface Table {
  fields: Array<{ id: string; type: string }>;
  rows: Array<Record<string, string | number | null>>;
  total: number;
}

const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d\d-\d\d/.test(v) ? v.slice(0, 10) : null);
const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

export function searchUrl(q: string, rows = 10): string {
  return `${CKAN}package_search?q=${encodeURIComponent(q)}&rows=${rows}`;
}

export function showUrl(name: string): string {
  return `${CKAN}package_show?id=${encodeURIComponent(name)}`;
}

/** Rows of a resource. `limit` is capped at 32 000 (CKAN's default maximum). */
export function datastoreUrl(resourceId: string, limit = 1000, offset = 0): string {
  return `${CKAN}datastore_search?resource_id=${encodeURIComponent(resourceId)}&limit=${Math.min(Math.max(limit, 1), 32000)}${offset ? `&offset=${offset}` : ""}`;
}

export function seriesUrl(id: string): string {
  return `${CBS_SERIES}?id=${encodeURIComponent(id)}&format=json&download=false`;
}

function ckanResult(json: unknown): Record<string, unknown> {
  const j = (json ?? {}) as { success?: boolean; result?: unknown; error?: { message?: string } };
  if (j.success === false) throw new DataGovError(j.error?.message ?? "CKAN error");
  return (j.result ?? {}) as Record<string, unknown>;
}

function toHit(p: Record<string, unknown>): DatasetHit {
  const org = p.organization as { title?: string } | null | undefined;
  const resources = Array.isArray(p.resources) ? (p.resources as Array<Record<string, unknown>>) : [];
  return {
    name: s(p.name),
    title: s(p.title) || s(p.name),
    organization: org?.title ?? null,
    modified: day(p.metadata_modified),
    resources: resources.map((r) => ({ id: s(r.id), name: s(r.name) || s(r.id), format: s(r.format).toUpperCase(), datastore: r.datastore_active === true })),
  };
}

export function parseSearch(json: unknown): DatasetHit[] {
  const r = ckanResult(json);
  return (Array.isArray(r.results) ? (r.results as Array<Record<string, unknown>>) : []).map(toHit);
}

export function parseShow(json: unknown): DatasetHit {
  return toHit(ckanResult(json));
}

export function parseDatastore(json: unknown): Table {
  const r = ckanResult(json);
  const fields = (Array.isArray(r.fields) ? (r.fields as Array<{ id?: string; type?: string }>) : []).filter((f) => f.id && f.id !== "_id").map((f) => ({ id: f.id!, type: f.type ?? "text" }));
  const rows = (Array.isArray(r.records) ? (r.records as Array<Record<string, unknown>>) : []).map((rec) => {
    const out: Record<string, string | number | null> = {};
    for (const f of fields) {
      const v = rec[f.id];
      out[f.id] = typeof v === "number" || v === null ? v : v === undefined ? null : String(v);
    }
    return out;
  });
  return { fields, rows, total: typeof r.total === "number" ? r.total : rows.length };
}

/** A CBS series as a two-column table (period, value), plus its name. */
export function parseSeries(json: unknown): { name: string; unit: string | null; table: Table } {
  const ds = ((json ?? {}) as { DataSet?: { Series?: Array<Record<string, unknown>> } }).DataSet;
  const series = ds?.Series?.[0];
  if (!series) throw new DataGovError("CBS answered with no series");
  const path = series.path as Record<string, { name?: string }> | undefined;
  const name = path ? Object.values(path).map((p) => p?.name).filter(Boolean).join(" — ") : s(series.id);
  const unit = (series.unit as { name?: string } | undefined)?.name ?? null;
  const obs = Array.isArray(series.obs) ? (series.obs as Array<{ TimePeriod?: string; Value?: number | string }>) : [];
  const rows = obs.map((o) => ({ period: s(o.TimePeriod), value: typeof o.Value === "number" ? o.Value : o.Value == null ? null : Number(o.Value) }));
  return { name: name || s(series.id), unit, table: { fields: [{ id: "period", type: "text" }, { id: "value", type: "numeric" }], rows, total: rows.length } };
}

async function getJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new DataGovError(`answered ${res.status}`, res.status);
  return res.json();
}

export const searchDatasets = async (q: string, f: typeof fetch) => parseSearch(await getJson(searchUrl(q), f));
export const showDataset = async (name: string, f: typeof fetch) => parseShow(await getJson(showUrl(name), f));
export const fetchTable = async (resourceId: string, f: typeof fetch, limit = 1000) => parseDatastore(await getJson(datastoreUrl(resourceId, limit), f));
export const fetchSeries = async (id: string, f: typeof fetch) => parseSeries(await getJson(seriesUrl(id), f));
