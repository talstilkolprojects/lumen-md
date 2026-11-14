/**
 * The Knesset's public OData service (plan W7.5): laws, bills, committees,
 * committee sessions and their documents. No key, no account.
 *
 *  - V4 (the plan's endpoint): https://knesset.gov.il/OdataV4/ParliamentInfo/<Entity>
 *    with `contains(Name,'…')`.
 *  - V3: https://knesset.gov.il/Odata/ParliamentInfo.svc/<Entity> with
 *    `substringof('…',Name)` and `$format=json`. Community clients
 *    (amnir/knessy, hasadna/knesset-data-pipelines) use V3 and report
 *    that V4 answers some clients with 403 or a bot challenge, so a 403
 *    or 404 on V4 is retried once on V3 — through the same gated fetch,
 *    so the retry is in the ledger too.
 *
 * Entity and field names follow the Knesset's schema as the hasadna
 * pipelines record it (laws/, bills/ and committees/ source specs):
 * KNS_IsraelLaw, KNS_IsraelLawName, KNS_Bill, KNS_Committee,
 * KNS_CommitteeSession and KNS_DocumentCommitteeSession.
 *
 * What leaves the device: the words of the law's name, a bill's name, or a
 * committee/session id — never the note.
 */

import type { LawRecord } from "./lawNames";

export const ODATA_V4 = "https://knesset.gov.il/OdataV4/ParliamentInfo/";
export const ODATA_V3 = "https://knesset.gov.il/Odata/ParliamentInfo.svc/";

export type Entity = "KNS_IsraelLaw" | "KNS_IsraelLawName" | "KNS_Bill" | "KNS_Committee" | "KNS_CommitteeSession" | "KNS_DocumentCommitteeSession";

/** One quote doubled, as OData string literals need. */
export function odataString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export interface Query {
  filter?: { contains?: { field: string; value: string }; eq?: Array<{ field: string; value: number | string }> };
  select?: string[];
  top?: number;
  orderby?: string;
}

function filterText(q: Query, version: 3 | 4): string | null {
  const parts: string[] = [];
  const c = q.filter?.contains;
  if (c) parts.push(version === 4 ? `contains(${c.field},${odataString(c.value)})` : `substringof(${odataString(c.value)},${c.field})`);
  for (const e of q.filter?.eq ?? []) parts.push(`${e.field} eq ${typeof e.value === "number" ? e.value : odataString(e.value)}`);
  return parts.length ? parts.join(" and ") : null;
}

/** The request URL for a query, in either version. */
export function queryUrl(entity: Entity, q: Query, version: 3 | 4 = 4): string {
  const params: string[] = [];
  const f = filterText(q, version);
  if (f) params.push(`$filter=${encodeURIComponent(f)}`);
  if (q.select?.length) params.push(`$select=${q.select.join(",")}`);
  if (q.orderby) params.push(`$orderby=${encodeURIComponent(q.orderby)}`);
  params.push(`$top=${Math.min(Math.max(q.top ?? 20, 1), 100)}`);
  if (version === 3) params.push("$format=json");
  return `${version === 4 ? ODATA_V4 : ODATA_V3}${entity}?${params.join("&")}`;
}

export class KnessetError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "KnessetError";
  }
}

/** Rows of an OData answer: V4 and V3 both return `{ value: [...] }` (V3 verbose JSON: `{ d: { results } }`). */
export function rowsOf(json: unknown): Array<Record<string, unknown>> {
  const j = (json ?? {}) as { value?: unknown; d?: { results?: unknown } | unknown[] };
  if (Array.isArray(j.value)) return j.value as Array<Record<string, unknown>>;
  if (Array.isArray(j.d)) return j.d as Array<Record<string, unknown>>;
  const r = (j.d as { results?: unknown } | undefined)?.results;
  return Array.isArray(r) ? (r as Array<Record<string, unknown>>) : [];
}

/** GET a query: V4 first, V3 once on 403/404. */
export async function odataGet(entity: Entity, q: Query, fetchImpl: typeof fetch): Promise<Array<Record<string, unknown>>> {
  let res = await fetchImpl(queryUrl(entity, q, 4), { headers: { Accept: "application/json" } });
  if (res.status === 403 || res.status === 404) res = await fetchImpl(queryUrl(entity, q, 3), { headers: { Accept: "application/json" } });
  if (!res.ok) throw new KnessetError(`Knesset OData answered ${res.status}`, res.status);
  return rowsOf(await res.json());
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? null : String(v));
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);
/** OData dates: ISO in V4, "/Date(…)/" in V3 verbose JSON. Returned as YYYY-MM-DD. */
export function odataDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const ms = /^\/Date\((-?\d+)/.exec(v);
  const d = ms ? new Date(Number(ms[1])) : /^\d{4}-\d\d-\d\d/.test(v) ? new Date(v.slice(0, 10) + "T00:00:00Z") : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

export interface Law extends LawRecord {
  knessetNum: number | null;
  publicationDate: string | null;
  latestPublicationDate: string | null;
  validity: string | null;
  isBudgetLaw: boolean;
  lastUpdated: string | null;
}

export function toLaw(r: Record<string, unknown>): Law | null {
  const id = num(r.IsraelLawID);
  const name = str(r.Name);
  if (id === null || !name) return null;
  return {
    id,
    name: name.trim(),
    isBasicLaw: r.IsBasicLaw === true,
    isBudgetLaw: r.IsBudgetLaw === true,
    knessetNum: num(r.KnessetNum),
    publicationDate: odataDate(r.PublicationDate),
    latestPublicationDate: odataDate(r.LatestPublicationDate),
    validity: str(r.LawValidityDesc),
    lastUpdated: odataDate(r.LastUpdatedDate),
  };
}

export interface Bill {
  id: number;
  name: string;
  knessetNum: number | null;
  subType: string | null;
  privateNumber: number | null;
  publicationDate: string | null;
  summary: string | null;
}

export function toBill(r: Record<string, unknown>): Bill | null {
  const id = num(r.BillID);
  const name = str(r.Name);
  if (id === null || !name) return null;
  return { id, name: name.trim(), knessetNum: num(r.KnessetNum), subType: str(r.SubTypeDesc), privateNumber: num(r.PrivateNumber), publicationDate: odataDate(r.PublicationDate), summary: str(r.SummaryLaw) };
}

export interface CommitteeSession {
  id: number;
  committeeId: number | null;
  number: number | null;
  knessetNum: number | null;
  startDate: string | null;
  url: string | null;
}

export function toSession(r: Record<string, unknown>): CommitteeSession | null {
  const id = num(r.CommitteeSessionID);
  if (id === null) return null;
  return { id, committeeId: num(r.CommitteeID), number: num(r.Number), knessetNum: num(r.KnessetNum), startDate: odataDate(r.StartDate), url: str(r.SessionUrl) };
}

export interface SessionDocument {
  id: number;
  sessionId: number;
  /** GroupTypeDesc: "פרוטוקול ועדה", "חוות דעת", "מצגת"… */
  kind: string;
  /** ApplicationDesc: DOC, PDF… */
  format: string | null;
  url: string;
  /** Only the protocol itself is a Knesset record under §6; the rest is kept as a link. */
  isProtocol: boolean;
}

export function toDocument(r: Record<string, unknown>): SessionDocument | null {
  const id = num(r.DocumentCommitteeSessionID);
  const sessionId = num(r.CommitteeSessionID);
  const url = str(r.FilePath);
  if (id === null || sessionId === null || !url) return null;
  const kind = str(r.GroupTypeDesc) ?? "";
  return { id, sessionId, kind, format: str(r.ApplicationDesc), url, isProtocol: /פרוטוקול/.test(kind) };
}

/** Laws whose name contains `term`, with their other names. */
export async function searchLaws(term: string, fetchImpl: typeof fetch): Promise<Law[]> {
  const rows = await odataGet("KNS_IsraelLaw", { filter: { contains: { field: "Name", value: term } }, top: 50 }, fetchImpl);
  return rows.map(toLaw).filter((l): l is Law => l !== null);
}

export async function searchBills(term: string, fetchImpl: typeof fetch): Promise<Bill[]> {
  const rows = await odataGet("KNS_Bill", { filter: { contains: { field: "Name", value: term } }, top: 20, orderby: "KnessetNum desc" }, fetchImpl);
  return rows.map(toBill).filter((b): b is Bill => b !== null);
}

export async function sessionDocuments(sessionId: number, fetchImpl: typeof fetch): Promise<SessionDocument[]> {
  const rows = await odataGet("KNS_DocumentCommitteeSession", { filter: { eq: [{ field: "CommitteeSessionID", value: sessionId }] }, top: 50 }, fetchImpl);
  return rows.map(toDocument).filter((d): d is SessionDocument => d !== null);
}

export async function session(sessionId: number, fetchImpl: typeof fetch): Promise<CommitteeSession | null> {
  const rows = await odataGet("KNS_CommitteeSession", { filter: { eq: [{ field: "CommitteeSessionID", value: sessionId }] }, top: 1 }, fetchImpl);
  return rows.map(toSession).find((s) => s !== null) ?? null;
}

/**
 * The record's own address in the OData service: the source link a saved
 * law or bill carries. (The Knesset site's legislation pages key on other
 * ids — KNS_Law.LawID — so the record URL is the one link that is sure.)
 */
export function recordUrl(entity: Entity, id: number): string {
  return `${ODATA_V4}${entity}(${id})`;
}
